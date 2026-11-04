import { fireEvent, render, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appLogger } from "../../stores/appLogger";
import { ProviderRecoveryStatus } from "./ProviderRecoveryStatus";

beforeEach(() => vi.stubGlobal("__TAURI_SHIM__", true));
afterEach(() => vi.unstubAllGlobals());

describe("provider recovery", () => {
	it("keeps an elapsed retry visible instead of claiming recovery succeeded", () => {
		const view = render(() => (
			<ProviderRecoveryStatus sessionId="ego-a" recovery={{ phase: "waiting", attempt: 3, next_attempt_ms: 1000 }} />
		));
		expect(view.getByRole("status").textContent).toContain("Waiting for provider recovery · waiting · attempt 3");
		expect(view.getByRole("status").textContent).toContain("(0s)");
	});

	it("submits retry once to its own session without a second click racing", async () => {
		let finish!: (response: Response) => void;
		const fetch = vi.fn(
			() =>
				new Promise<Response>((resolve) => {
					finish = resolve;
				}),
		);
		vi.stubGlobal("fetch", fetch);
		const view = render(() => (
			<ProviderRecoveryStatus sessionId="ego-a" recovery={{ phase: "retrying", attempt: 4, next_attempt_ms: null }} />
		));
		expect(view.getByRole("status").textContent).toContain("retrying · attempt 4");
		const button = view.getByRole("button", { name: "Force retry" });
		fireEvent.click(button);
		fireEvent.click(button);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/sessions\/ego-a\/force-retry$/), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
		});
		expect(button.hasAttribute("disabled")).toBe(true);
		finish(new Response("null", { headers: { "Content-Type": "application/json" } }));
		await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
	});
});

// Catches: clicking force retry destroys an unrelated draft already in ego's composer.
it("preserves an existing composer draft when force retry is requested", async () => {
	// The real backend's draft refusal is covered by provider_recovery_force_retry_targets_only_recovering_ego.
	const fetch = vi.fn(
		async () => new Response(JSON.stringify({ error: "Session composer is not empty" }), { status: 409 }),
	);
	vi.stubGlobal("fetch", fetch);
	const warning = vi.spyOn(appLogger, "warn").mockImplementation(() => {});
	try {
		const view = render(() => (
			<ProviderRecoveryStatus
				recovery={{ phase: "waiting", next_attempt_ms: Date.now() + 60000, attempt: 2 }}
				sessionId="draft-session"
			/>
		));
		fireEvent.click(view.getByRole("button", { name: "Force retry" }));
		await waitFor(() => expect(view.getByRole("alert").textContent).toContain("Session composer is not empty"));
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(fetch).toHaveBeenCalledWith(expect.stringMatching(/\/sessions\/draft-session\/force-retry$/), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
		});
		expect(warning).toHaveBeenCalledWith("terminal", "Force retry failed", expect.any(Error));
	} finally {
		warning.mockRestore();
	}
});
