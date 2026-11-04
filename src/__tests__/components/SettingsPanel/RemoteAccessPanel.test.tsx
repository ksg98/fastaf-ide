import { fireEvent, render, screen } from "@solidjs/testing-library";
import QRCode from "qrcode";
import { ErrorBoundary } from "solid-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../stores/appLogger", () => ({
	appLogger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
// Only `rpc` is replaced: `invoke` (the config defaults) needs the real
// `isTauri` and connection resolver to reach the Tauri mock.
vi.mock("../../../transport", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../transport")>()),
	rpc: vi.fn(),
}));
/** Whether the panel believes it runs on macOS (the paused notice names "this Mac"). */
const mac = vi.hoisted(() => ({ value: false }));
vi.mock("../../../platform", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../platform")>()),
	isMacOS: () => mac.value,
}));
vi.mock("../../../utils/updateAppConfig", () => ({ updateAppConfig: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../../stores/ui", async () => {
	const { createStore } = await import("solid-js/store");
	const [state, setState] = createStore({ settingsExpertMode: false });
	return {
		uiStore: {
			state,
			setSettingsExpertMode: vi.fn((enabled: boolean) => setState("settingsExpertMode", enabled)),
		},
	};
});

import { RemoteQrDialog } from "../../../components/RemoteQrDialog/RemoteQrDialog";
import { RemoteAccessPanel } from "../../../components/SettingsPanel/tabs/services/RemoteAccessPanel";
import { settingsExpertStore } from "../../../stores/settingsExpert";
import { uiStore } from "../../../stores/ui";
import { rpc } from "../../../transport";
import { updateAppConfig } from "../../../utils/updateAppConfig";
import { mockInvoke } from "../../mocks/tauri";

vi.mock("qrcode", () => ({ default: { toDataURL: vi.fn().mockResolvedValue("data:image/png;base64,AA==") } }));

describe("RemoteAccessPanel", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.mocked(rpc).mockImplementation((command: string) => {
			if (command === "get_mcp_status") {
				return Promise.resolve({
					enabled: true,
					running: true,
					remote_port: null,
					active_sessions: 0,
					mcp_clients: 0,
					max_sessions: 10,
					reachable: null,
				});
			}
			if (command === "get_relay_status") {
				return Promise.resolve({ enabled: false, connected: false, url: "", session_id: "" });
			}
			if (command === "load_config") {
				return Promise.resolve({
					services: {
						server: { enabled: false, port: 9876, ipv6_enabled: false },
						auth: { username: "", password_hash: "", session_token_duration_secs: 86400, lan_auth_bypass: false },
						relay: { enabled: false, url: "", session_id: "" },
					},
				});
			}
			if (command === "get_local_ips") return Promise.resolve([]);
			if (command === "get_tailscale_status") return Promise.resolve({ state: "NotInstalled" });
			return Promise.resolve(undefined);
		});
	});

	afterEach(() => {
		settingsExpertStore._resetForTests();
		uiStore.setSettingsExpertMode(false);
		vi.clearAllTimers();
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it.each(["settings", "dialog"] as const)(
		"keeps the %s surface after rejected IP discovery and recovers on retry",
		async (surface) => {
			const base = vi.mocked(rpc).getMockImplementation()!;
			let discoveries = 0;
			vi.mocked(rpc).mockImplementation(async (command, args) => {
				if (command === "get_local_ips") {
					if (++discoveries < 3) throw new Error("Discovery unavailable: " + "network-interface/".repeat(20));
					return [{ ip: "192.168.1.42", label: "LAN" }];
				}
				if (command === "get_connect_url") return "http://192.168.1.42:9876/connect";
				const result = await base(command, args);
				if (command === "load_config") {
					const config = result as { services: { server: { enabled: boolean } } };
					config.services.server.enabled = true;
				}
				return result;
			});
			const view = render(() => (
				<ErrorBoundary fallback={<p>Whole surface crashed</p>}>
					{surface === "settings" ? <RemoteAccessPanel /> : <RemoteQrDialog onClose={() => {}} />}
				</ErrorBoundary>
			));
			await vi.advanceTimersByTimeAsync(0);
			// Catches: a failed resource read replaces the entire surface, or Retry cannot recover it.
			expect(view.queryByText("Whole surface crashed")).toBeNull();
			expect(view.getByText(surface === "settings" ? "Remote Access" : "Remote Mobile Connection")).toBeDefined();
			expect(view.getByRole("alert").textContent).toContain("Discovery unavailable:");
			if (surface === "settings") {
				expect(view.getByLabelText("Username")).toBeDefined();
				expect(view.getByLabelText("Relay Server URL")).toBeDefined();
			}
			for (let attempt = 0; attempt < 2; attempt++) {
				fireEvent.click(view.getByRole("button", { name: "Retry" }));
				await vi.advanceTimersByTimeAsync(0);
				if (attempt === 0) expect(view.getByRole("alert").textContent).toContain("Discovery unavailable:");
			}
			expect(discoveries).toBe(3);
			expect(view.queryByRole("alert")).toBeNull();
			expect(view.getByText("http://192.168.1.42:9876/connect")).toBeDefined();
			expect(
				view.getByAltText(surface === "settings" ? "QR code" : "QR code for remote mobile connection"),
			).toBeDefined();
			view.unmount();
		},
	);

	it.each(["settings", "dialog"] as const)(
		"keeps backend-ranked LAN ahead of HTTP-only Tailscale in the %s surface",
		async (surface) => {
			// Catches: frontend label ranking overriding the backend's live-listener policy.
			const base = vi.mocked(rpc).getMockImplementation()!;
			vi.mocked(rpc).mockImplementation(async (command, args) => {
				if (command === "get_local_ips") {
					return [
						{ ip: "192.168.1.42", label: "LAN (en0)" },
						{ ip: "100.64.1.2", label: "Tailscale (utun0)" },
					];
				}
				if (command === "get_connect_url") return "http://192.168.1.42:9876/connect";
				return base(command, args);
			});
			const view = render(() =>
				surface === "settings" ? <RemoteAccessPanel /> : <RemoteQrDialog onClose={() => {}} />,
			);
			await vi.advanceTimersByTimeAsync(0);
			const urlCalls = vi.mocked(rpc).mock.calls.filter(([command]) => command === "get_connect_url");
			expect(urlCalls.length).toBeGreaterThan(0);
			for (const call of urlCalls) expect(call).toEqual(["get_connect_url", { ip: "192.168.1.42" }]);
			view.unmount();
		},
	);

	function mockPairing({ enabled = true, bindAddress }: { enabled?: boolean; bindAddress?: string } = {}) {
		const base = vi.mocked(rpc).getMockImplementation()!;
		const live = {
			tls_active: false,
			remote_port: 9876,
			active_sessions: 0,
			token: "first",
			remote_bind_state: "listening",
			remote_bind_address: "",
		};
		vi.mocked(rpc).mockImplementation(async (command, args) => {
			if (command === "get_local_ips")
				return [
					{ ip: "192.168.1.42", label: "LAN" },
					{ ip: "100.64.1.2", label: "Tailscale" },
				];
			if (command === "get_connect_url")
				return `${live.tls_active ? "https" : "http"}://${args?.ip}:${live.remote_port}/connect?token=${live.token}`;
			if (command === "regenerate_session_token") {
				live.token = "second";
				return;
			}
			const result = await base(command, args);
			if (command === "get_mcp_status") return { ...(result as object), ...live };
			if (command === "load_config") {
				const server = (result as { services: { server: { enabled: boolean; bind_address?: string } } }).services
					.server;
				server.enabled = enabled;
				if (bindAddress !== undefined) server.bind_address = bindAddress;
			}
			return result;
		});
		return live;
	}

	describe("listen address", () => {
		/** The `services.server` the panel's saves produce, applied to a stored copy. */
		const savedServer = () => {
			const config = { services: { server: { enabled: true, port: 9876, ipv6_enabled: false, bind_address: "" } } };
			for (const [updater] of vi.mocked(updateAppConfig).mock.calls) (updater as (c: unknown) => void)(config);
			return config.services.server;
		};
		const interfacePicker = (view: ReturnType<typeof render>) =>
			view.getByLabelText("Network Interface") as HTMLSelectElement;

		// Catches: the interface picker only choosing the QR address while the
		// server keeps listening on every network the machine joins.
		it("saves the picked interface as the listen address, and All interfaces as empty", async () => {
			mockPairing();
			const view = render(() => <RemoteAccessPanel />);
			await vi.advanceTimersByTimeAsync(0);
			const picker = interfacePicker(view);
			expect(Array.from(picker.options).map((option) => option.textContent)).toEqual([
				"All interfaces",
				"LAN — 192.168.1.42",
				"Tailscale — 100.64.1.2",
			]);
			expect(picker.value).toBe("");
			fireEvent.change(picker, { target: { value: "100.64.1.2" } });
			await vi.advanceTimersByTimeAsync(0);
			expect(savedServer().bind_address).toBe("100.64.1.2");
			expect(view.getByText("http://100.64.1.2:9876/connect?token=first")).toBeDefined();
			fireEvent.change(picker, { target: { value: "" } });
			expect(savedServer().bind_address).toBe("");
			view.unmount();
		});

		it("opens on the saved listen address and pairs through it", async () => {
			mockPairing({ bindAddress: "100.64.1.2" });
			const view = render(() => <RemoteAccessPanel />);
			await vi.advanceTimersByTimeAsync(0);
			expect(interfacePicker(view).value).toBe("100.64.1.2");
			expect(view.getByText("http://100.64.1.2:9876/connect?token=first")).toBeDefined();
			expect(vi.mocked(updateAppConfig)).not.toHaveBeenCalled();
			view.unmount();
		});

		// Catches: a saved address the machine no longer has blanking the picker.
		it("names a saved address this machine no longer has", async () => {
			mockPairing({ bindAddress: "10.0.0.9" });
			const view = render(() => <RemoteAccessPanel />);
			await vi.advanceTimersByTimeAsync(0);
			const picker = interfacePicker(view);
			expect(picker.value).toBe("10.0.0.9");
			expect(picker.selectedOptions[0]?.textContent).toBe("10.0.0.9 — not on this machine");
			view.unmount();
		});

		const notice = (view: ReturnType<typeof render>, state: "paused" | "failed") =>
			view.container.querySelector(`[data-remote-bind-state="${state}"]`)?.textContent ?? null;

		// Catches: a pairing link and QR offered while the backend, failing closed,
		// listens on loopback only because the saved address is not on the machine.
		it("says remote access is paused and hides the pairing link until the address appears", async () => {
			const live = mockPairing({ bindAddress: "10.0.0.9" });
			live.remote_bind_state = "paused_address_unavailable";
			live.remote_bind_address = "10.0.0.9";
			mac.value = true;
			try {
				const view = render(() => <RemoteAccessPanel />);
				await vi.advanceTimersByTimeAsync(0);
				expect(notice(view, "paused")).toBe("Remote access paused: 10.0.0.9 isn't on this Mac yet");
				expect(view.queryByAltText("QR code")).toBeNull();
				expect(view.queryByText(/\/connect\?token=/)).toBeNull();
				expect(view.container.querySelector("[data-cleartext-warning]")).toBeNull();
				expect(view.queryByText("Scan the QR code to connect from another device")).toBeNull();
				expect(view.container.querySelector("[data-remote-pairing]")).toBeNull();

				// The backend rebinds by itself once the address appears; the next poll clears it.
				live.remote_bind_state = "listening";
				live.remote_bind_address = "";
				await vi.advanceTimersByTimeAsync(3000);
				expect(notice(view, "paused")).toBeNull();
				expect(view.getByAltText("QR code")).toBeDefined();
				view.unmount();
			} finally {
				mac.value = false;
			}
		});

		it("names this machine, not a Mac, off macOS", async () => {
			const live = mockPairing({ bindAddress: "10.0.0.9" });
			live.remote_bind_state = "paused_address_unavailable";
			live.remote_bind_address = "10.0.0.9";
			const view = render(() => <RemoteAccessPanel />);
			await vi.advanceTimersByTimeAsync(0);
			expect(notice(view, "paused")).toBe("Remote access paused: 10.0.0.9 isn't on this machine yet");
			view.unmount();
		});

		it("says remote access could not start when no port is free, and hides the pairing link", async () => {
			const live = mockPairing();
			live.remote_bind_state = "failed";
			const view = render(() => <RemoteAccessPanel />);
			await vi.advanceTimersByTimeAsync(0);
			expect(notice(view, "failed")).toBe("Remote access could not start: no free port");
			expect(view.queryByAltText("QR code")).toBeNull();
			view.unmount();
		});

		// Catches: the QR column squeezing the interface picker to "Wi-Fi (en0) — 192.1…"
		// and the link wrapping mid-port: the pairing block must be a row of its own.
		it("puts the QR and its link on their own row below the settings, the link whole", async () => {
			mockPairing();
			const view = render(() => <RemoteAccessPanel />);
			await vi.advanceTimersByTimeAsync(0);
			const pairing = view.container.querySelector("[data-remote-pairing]") as HTMLElement;
			const picker = interfacePicker(view);
			expect(pairing.contains(picker)).toBe(false);
			expect(pairing.parentElement?.contains(picker)).toBe(true);
			expect(picker.compareDocumentPosition(pairing) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
			const link = pairing.querySelector("code") as HTMLElement;
			expect(link.textContent).toBe("http://192.168.1.42:9876/connect?token=first");
			expect(link.title).toBe("http://192.168.1.42:9876/connect?token=first");
			expect(link.getAttribute("style")).toBeNull();
			expect(pairing.querySelector("img")?.getAttribute("alt")).toBe("QR code");
			view.unmount();
		});

		it("shows neither notice while the listener is up", async () => {
			mockPairing();
			const view = render(() => <RemoteAccessPanel />);
			await vi.advanceTimersByTimeAsync(0);
			expect(notice(view, "paused")).toBeNull();
			expect(notice(view, "failed")).toBeNull();
			expect(view.getByAltText("QR code")).toBeDefined();
			view.unmount();
		});
	});

	// Catches: the panel keeping the QR and URL of a token the backend revoked
	// when remote access went from off to on.
	it("fetches the pairing URL again after remote access is switched on", async () => {
		const live = mockPairing({ enabled: false });
		// The backend issues a new session token on every off-to-on switch.
		vi.mocked(updateAppConfig).mockImplementationOnce(async (updater) => {
			const config = { services: { server: { enabled: false } } };
			(updater as (c: typeof config) => void)(config);
			if (config.services.server.enabled) live.token = "second";
			return undefined as never;
		});
		const view = render(() => <RemoteAccessPanel />);
		await vi.advanceTimersByTimeAsync(0);
		fireEvent.click(view.getByRole("switch", { name: /Enable remote access/ }));
		await vi.advanceTimersByTimeAsync(0);
		expect(view.getByText("http://192.168.1.42:9876/connect?token=second")).toBeDefined();
		expect(view.queryByText("http://192.168.1.42:9876/connect?token=first")).toBeNull();
		expect(QRCode.toDataURL).toHaveBeenLastCalledWith(
			"http://192.168.1.42:9876/connect?token=second",
			expect.any(Object),
		);
		view.unmount();
	});

	// Catches: a cleartext pairing link shown with no word that anyone on the
	// network can read the token, or the warning nagging over Tailscale TLS.
	it("warns that an http pairing link is unencrypted, and not once it is https", async () => {
		const live = mockPairing();
		const warning = (view: ReturnType<typeof render>) =>
			view.container.querySelector("[data-cleartext-warning]")?.textContent ?? null;
		const view = render(() => <RemoteAccessPanel />);
		await vi.advanceTimersByTimeAsync(0);
		expect(warning(view)).toBe(
			"Traffic is unencrypted on this network; anyone on the same Wi-Fi can take over your terminals. Use Tailscale for encryption.",
		);
		live.tls_active = true;
		await vi.advanceTimersByTimeAsync(3000);
		expect(view.getByText("https://192.168.1.42:9876/connect?token=first")).toBeDefined();
		expect(warning(view)).toBeNull();
		view.unmount();
	});

	it("unchanged_status_poll_does_not_regenerate_remote_qr", async () => {
		// Catches: subscribing to the full status object repeats URL requests and QR encoding every poll.
		const live = mockPairing();
		const view = render(() => <RemoteAccessPanel />);
		await vi.advanceTimersByTimeAsync(0);
		const requests = () => vi.mocked(rpc).mock.calls.filter(([command]) => command === "get_connect_url").length;
		expect(requests()).toBeGreaterThan(0);
		const initialRequests = requests();
		const initialEncodes = vi.mocked(QRCode.toDataURL).mock.calls.length;
		await vi.advanceTimersByTimeAsync(6000);
		live.active_sessions = 3;
		await vi.advanceTimersByTimeAsync(3000);
		expect(requests()).toBe(initialRequests);
		expect(QRCode.toDataURL).toHaveBeenCalledTimes(initialEncodes);
		expect(view.getByAltText("QR code")).toBeDefined();
		view.unmount();
	});

	it("refreshes pairing for TLS, listener port, selected address and successful token rotation", async () => {
		// Catches: deduplicating all polls also suppresses real URL input changes.
		const live = mockPairing();
		const view = render(() => <RemoteAccessPanel />);
		await vi.advanceTimersByTimeAsync(0);
		live.tls_active = true;
		await vi.advanceTimersByTimeAsync(3000);
		expect(view.getByText("https://192.168.1.42:9876/connect?token=first")).toBeDefined();
		live.remote_port = 9988;
		await vi.advanceTimersByTimeAsync(3000);
		expect(view.getByText("https://192.168.1.42:9988/connect?token=first")).toBeDefined();
		fireEvent.change(view.getByLabelText("Network Interface"), { target: { value: "100.64.1.2" } });
		await vi.advanceTimersByTimeAsync(0);
		expect(view.getByText("https://100.64.1.2:9988/connect?token=first")).toBeDefined();
		fireEvent.click(view.getByRole("button", { name: "Regenerate Token" }));
		fireEvent.click(screen.getByRole("button", { name: "Regenerate token" }));
		await vi.advanceTimersByTimeAsync(0);
		expect(view.getByText("https://100.64.1.2:9988/connect?token=second")).toBeDefined();
		expect(QRCode.toDataURL).toHaveBeenLastCalledWith(
			"https://100.64.1.2:9988/connect?token=second",
			expect.any(Object),
		);
		view.unmount();
	});

	it.each(["url", "qr"] as const)("ignores obsolete in-flight %s results after address selection", async (stage) => {
		// Catches: an old asynchronous URL or encoder completion overwrites the current address's QR.
		mockPairing();
		const base = vi.mocked(rpc).getMockImplementation()!;
		let finishOld!: (value: string) => void;
		const old = new Promise<string>((resolve) => {
			finishOld = resolve;
		});
		vi.mocked(rpc).mockImplementation((command, args) => {
			if (stage === "url" && command === "get_connect_url" && args?.ip === "192.168.1.42") return old;
			return base(command, args);
		});
		vi.mocked(QRCode.toDataURL).mockImplementation((url) => {
			if (stage === "qr" && String(url).includes("192.168.1.42")) return old;
			return Promise.resolve("data:image/png;base64,CURRENT");
		});
		const view = render(() => <RemoteAccessPanel />);
		await vi.advanceTimersByTimeAsync(0);
		fireEvent.change(view.getByLabelText("Network Interface"), { target: { value: "100.64.1.2" } });
		await vi.advanceTimersByTimeAsync(0);
		finishOld(stage === "url" ? "http://old.invalid/connect" : "data:image/png;base64,OBSOLETE");
		await vi.advanceTimersByTimeAsync(0);
		expect(view.getByText("http://100.64.1.2:9876/connect?token=first")).toBeDefined();
		expect(view.getByAltText("QR code").getAttribute("src")).toBe("data:image/png;base64,CURRENT");
		expect(view.queryByText("http://old.invalid/connect")).toBeNull();
		view.unmount();
		vi.mocked(QRCode.toDataURL).mockImplementation(() => Promise.resolve("data:image/png;base64,AA=="));
	});

	it("does not advertise HTTPS after certificate provisioning failed", async () => {
		const base = vi.mocked(rpc).getMockImplementation()!;
		vi.mocked(rpc).mockImplementation(async (command, args) => {
			if (command === "get_tailscale_status") {
				// CertDomains remained available during the recorded bundle EPERM failure.
				return { state: "Running", fqdn: "dgqt92cjfp.tail911da.ts.net", https_enabled: true };
			}
			const result = await base(command, args);
			if (command === "get_mcp_status") return { ...(result as object), tls_active: false };
			return result;
		});
		const view = render(() => <RemoteAccessPanel />);
		await vi.advanceTimersByTimeAsync(0);
		expect(view.queryByText(/^HTTPS active/)).toBeNull();
		expect(view.getByText("Running (HTTPS unavailable)")).toBeDefined();
		view.unmount();
	});

	it("tracks listener readiness and shutdown through the existing status poll", async () => {
		const base = vi.mocked(rpc).getMockImplementation()!;
		let tlsActive = true;
		vi.mocked(rpc).mockImplementation(async (command, args) => {
			if (command === "get_tailscale_status") {
				return { state: "Running", fqdn: "dgqt92cjfp.tail911da.ts.net", https_enabled: true };
			}
			const result = await base(command, args);
			if (command === "get_mcp_status") return { ...(result as object), tls_active: tlsActive };
			return result;
		});
		const view = render(() => <RemoteAccessPanel />);
		await vi.advanceTimersByTimeAsync(0);
		expect(view.getByText("HTTPS active (dgqt92cjfp.tail911da.ts.net)")).toBeDefined();
		// Catches a retained capability snapshot keeping HTTPS active after shutdown.
		tlsActive = false;
		await vi.advanceTimersByTimeAsync(3000);
		expect(view.queryByText(/^HTTPS active/)).toBeNull();
		expect(view.getByText("Running (HTTPS unavailable)")).toBeDefined();
		tlsActive = true;
		await vi.advanceTimersByTimeAsync(3000);
		expect(view.getByText("HTTPS active (dgqt92cjfp.tail911da.ts.net)")).toBeDefined();
		view.unmount();
	});

	it("shows the remote-access content it owns", async () => {
		const view = render(() => <RemoteAccessPanel />);
		await vi.advanceTimersByTimeAsync(0);

		expect(view.getByText("Remote Access")).toBeDefined();
		expect(view.getByText("Cloud Relay")).toBeDefined();
		expect(view.getByText("Enable remote access")).toBeDefined();

		view.unmount();
	});

	it("never renders HTTP API Server or FastAF tools content — that belongs to LocalMcpPanel", async () => {
		const view = render(() => <RemoteAccessPanel />);
		await vi.advanceTimersByTimeAsync(0);

		expect(view.queryByText("HTTP API Server")).toBeNull();
		expect(view.queryByText("FastAF tools")).toBeNull();
		expect(view.queryByText("Server Status")).toBeNull();

		view.unmount();
	});

	it("owns a single get_mcp_status poll and clears it on unmount", async () => {
		const view = render(() => <RemoteAccessPanel />);
		const statusCalls = () => vi.mocked(rpc).mock.calls.filter(([command]) => command === "get_mcp_status").length;

		await vi.advanceTimersByTimeAsync(0);
		expect(statusCalls()).toBe(1);

		await vi.advanceTimersByTimeAsync(3000);
		expect(statusCalls()).toBe(2);

		view.unmount();
		await vi.advanceTimersByTimeAsync(6000);
		expect(statusCalls()).toBe(2);
	});

	/** Render the page over a saved `services` config. */
	async function renderWith(services: Record<string, unknown>) {
		const base = vi.mocked(rpc).getMockImplementation();
		vi.mocked(rpc).mockImplementation((command: string, args?: Record<string, unknown>) =>
			command === "load_config" ? Promise.resolve({ services }) : (base?.(command, args) as Promise<never>),
		);
		const view = render(() => <RemoteAccessPanel />);
		await vi.advanceTimersByTimeAsync(0);
		return view;
	}

	describe("expert controls", () => {
		const DEFAULT_SERVER = { enabled: false, port: 9876, ipv6_enabled: false };
		const DEFAULT_AUTH = {
			username: "",
			password_hash: "",
			session_token_duration_secs: 86400,
			lan_auth_bypass: false,
		};
		const DEFAULTS = {
			app: { services: { server: DEFAULT_SERVER, auth: DEFAULT_AUTH, relay: {} } },
			notifications: {},
			agent_settings: {},
		};

		/** Remote access switched on (the expert controls live under it), with the
		 * given overrides and the Rust defaults loaded. */
		async function renderEnabled(server: Record<string, unknown> = {}, auth: Record<string, unknown> = {}) {
			mockInvoke.mockImplementation((cmd: string) =>
				cmd === "get_config_defaults" ? Promise.resolve(DEFAULTS) : Promise.resolve(undefined),
			);
			await settingsExpertStore.open();
			return renderWith({
				server: { ...DEFAULT_SERVER, enabled: true, ...server },
				auth: { ...DEFAULT_AUTH, ...auth },
				relay: { enabled: false, url: "", session_id: "" },
			});
		}

		const EXPERT_LABELS = ["Port", "Session Token Duration", "Enable IPv6 (dual-stack)"];
		const shown = (view: ReturnType<typeof render>) =>
			EXPERT_LABELS.filter((label) => view.queryByText(label) !== null);

		it("hides Port, Token duration and IPv6 at their defaults", async () => {
			const view = await renderEnabled();
			expect(shown(view)).toEqual([]);
			// The basic credentials stay.
			expect(view.getByText("Username")).toBeDefined();
			expect(view.getByText("Password")).toBeDefined();
			view.unmount();
		});

		it("shows each control whose saved value differs from its default, and only that one", async () => {
			const cases: [Record<string, unknown>, Record<string, unknown>, string][] = [
				[{ port: 9999 }, {}, "Port"],
				[{}, { session_token_duration_secs: 3600 }, "Session Token Duration"],
				[{ ipv6_enabled: true }, {}, "Enable IPv6 (dual-stack)"],
			];
			for (const [server, auth, label] of cases) {
				const view = await renderEnabled(server, auth);
				expect(shown(view)).toEqual([label]);
				view.unmount();
			}
		});

		it("does not offer the retired LAN bypass from a saved config in expert mode", async () => {
			uiStore.setSettingsExpertMode(true);
			const view = await renderEnabled({}, { lan_auth_bypass: true });
			expect(view.queryByText("Allow LAN access without authentication")).toBeNull();
			expect(view.getByText("Username")).toBeDefined();
			expect(view.getByText("Password")).toBeDefined();
			expect(updateAppConfig).not.toHaveBeenCalled();
			view.unmount();
		});

		it("shows every control at its default in expert mode", async () => {
			uiStore.setSettingsExpertMode(true);
			const view = await renderEnabled();
			expect(shown(view)).toEqual(EXPERT_LABELS);
			view.unmount();
		});
	});

	it("does not revoke remote sessions before explicit confirmation", async () => {
		const view = await renderWith({
			server: { enabled: true, port: 9876, ipv6_enabled: false },
			auth: { username: "operator", password_hash: "", session_token_duration_secs: 86400 },
			relay: { enabled: false, url: "", session_id: "" },
		});
		fireEvent.click(view.getByRole("button", { name: "Regenerate Token" }));
		expect(vi.mocked(rpc).mock.calls.some(([command]) => command === "regenerate_session_token")).toBe(false);
		// FastAF's ConfirmDialog renders in a Portal, outside the panel container.
		expect(screen.getByText("Regenerate remote access token?")).toBeDefined();
		fireEvent.click(screen.getByRole("button", { name: "Regenerate token" }));
		await vi.advanceTimersByTimeAsync(0);
		expect(vi.mocked(rpc).mock.calls.filter(([command]) => command === "regenerate_session_token")).toHaveLength(1);
		view.unmount();
	});

	describe("cloud relay configuration", () => {
		const relayOff = {
			server: { enabled: false, port: 9876, ipv6_enabled: false },
			auth: { username: "", password_hash: "", session_token_duration_secs: 86400, lan_auth_bypass: false },
			relay: { enabled: false, url: "", session_id: "" },
		};
		const input = (view: ReturnType<typeof render>, label: string) => view.getByLabelText(label) as HTMLInputElement;

		// The relay starts only when it is enabled AND has a URL AND a token
		// (`relay_client.rs`), so both must be settable before switching it on —
		// and a search for either must land on a page that shows it.
		it("renders the relay URL and bearer token with the relay disabled", async () => {
			const view = await renderWith(relayOff);
			expect(input(view, "Relay Server URL")).not.toBeNull();
			expect(input(view, "Bearer Token")).not.toBeNull();
			view.unmount();
		});

		it("saves the relay URL and token while the relay stays disabled", async () => {
			const view = await renderWith(relayOff);
			fireEvent.input(input(view, "Relay Server URL"), { target: { value: "wss://relay.example" } });
			fireEvent.input(input(view, "Bearer Token"), { target: { value: "secret" } });

			const config = { services: structuredClone(relayOff) } as {
				services: typeof relayOff & { relay: Record<string, unknown> };
			};
			for (const [updater] of vi.mocked(updateAppConfig).mock.calls) (updater as (c: unknown) => void)(config);
			expect(config.services.relay).toEqual({
				enabled: false,
				url: "wss://relay.example",
				token: "secret",
				token_exists: true,
				session_id: "",
			});
			view.unmount();
		});

		// Catches: an unset relay URL pre-filled with upstream's relay server, which
		// FastAF does not run and the user never chose.
		it("leaves an unset relay URL empty, with a neutral example as placeholder", async () => {
			const view = await renderWith(relayOff);
			const url = input(view, "Relay Server URL");
			expect(url.value).toBe("");
			expect(url.placeholder).toBe("wss://relay.example.com");
			expect(view.container.innerHTML).not.toContain("tuicommander.com");
			view.unmount();
		});

		it("keeps the connection status and session ID hidden until the relay is enabled", async () => {
			const view = await renderWith(relayOff);
			expect(view.queryByText("Session ID")).toBeNull();
			expect(view.queryByText("Disconnected")).toBeNull();
			view.unmount();
		});
	});
});
