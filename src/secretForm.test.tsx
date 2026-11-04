import { fireEvent, screen, waitFor } from "@solidjs/testing-library";
import { invoke } from "@tauri-apps/api/core";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

afterEach(() => {
	vi.unstubAllGlobals();
	vi.resetModules();
	vi.clearAllMocks();
	document.body.innerHTML = "";
	history.replaceState(null, "", "/");
});

// Catches: index.html's browser Tauri shim selecting native bootstrap, or
// form fetches omitting the existing server's authentication cookie.
it("loads and submits the nonce form through the authenticated browser router", async () => {
	const nonce = "a".repeat(64);
	history.replaceState(null, "", `/index.html#/secret-form?nonce=${nonce}`);
	vi.stubGlobal("__TAURI_INTERNALS__", {});
	vi.stubGlobal("__TAURI_SHIM__", true);
	const fetch = vi
		.fn()
		.mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					id: "test",
					nonce,
					reason: "Login",
					argv: null,
					fields: [{ name: "PASS", kind: "password" }],
				}),
				{ status: 200 },
			),
		)
		.mockResolvedValueOnce(new Response("{}", { status: 200 }));
	vi.stubGlobal("fetch", fetch);
	const root = document.createElement("main");
	document.body.appendChild(root);
	const { startSecretForm } = await import("./secretForm");
	await startSecretForm(root);
	expect(fetch).toHaveBeenNthCalledWith(
		1,
		`/secrets/forms/${nonce}`,
		expect.objectContaining({
			credentials: "same-origin",
			cache: "no-store",
		}),
	);
	expect(window.location.hash).toBe("#/secret-form");
	fireEvent.input(screen.getByLabelText("PASS"), { target: { value: "synthetic-only" } });
	fireEvent.click(screen.getByRole("button", { name: "Store" }));
	await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
	expect(fetch).toHaveBeenNthCalledWith(
		2,
		"/secrets/forms/submit",
		expect.objectContaining({
			method: "POST",
			credentials: "same-origin",
			body: JSON.stringify({ nonce, status: "stored", values: { PASS: "synthetic-only" }, template: null }),
		}),
	);
	expect(root.querySelector("input")).toBeNull();
	expect(root.textContent).not.toContain("synthetic-only");
});

// Catches: the private native window using browser-only clipboard/navigation APIs.
it("copies and opens only the backend-issued native form URL", async () => {
	const nonce = "e".repeat(64);
	const url = `https://host.example:9876/index.html#/secret-form?nonce=${nonce}`;
	vi.stubGlobal("__TAURI_INTERNALS__", {});
	vi.mocked(invoke).mockResolvedValue({
		id: "native",
		nonce,
		reason: "Login",
		argv: null,
		fields: [],
		mobile_url: url,
	});
	const root = document.createElement("main");
	document.body.appendChild(root);
	const { startSecretForm } = await import("./secretForm");
	await startSecretForm(root);
	fireEvent.click(screen.getByRole("button", { name: "Copy form URL", hidden: true }));
	fireEvent.click(screen.getByRole("link", { name: url, hidden: true }));
	await waitFor(() => {
		expect(invoke).toHaveBeenCalledWith("write_clipboard_text", { text: url });
		expect(invoke).toHaveBeenCalledWith("open_default_app", { target: url, kind: "url" });
	});
});
