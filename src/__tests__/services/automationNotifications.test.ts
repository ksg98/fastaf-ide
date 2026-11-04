import { createRoot } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { invoke } from "../../invoke";
import { presentAutomationNotice } from "../../services/automationNotifications";
import { navigateFromNativeNotice } from "../../services/nativeNotificationNavigation";
import { automationsUi, createAutomationsStore } from "../../stores/automations";
import { toastsStore } from "../../stores/toasts";
import { fakeAdapter, runFixture } from "../automationsFixtures";

vi.mock("../../invoke", () => ({ invoke: vi.fn(), listen: vi.fn() }));
afterEach(() => {
	automationsUi.close();
	vi.clearAllMocks();
});
describe("automation notification navigation", () => {
	it("bell action selects the canonical run rather than the currently focused session", () => {
		const bell = vi.spyOn(toastsStore, "addToBell").mockReturnValue(1);
		const run = {
			...runFixture("canonical", "deleted-definition"),
			status: "needs_you" as const,
			session_id: "owning-session",
		};
		presentAutomationNotice({ notice: true, run });
		expect(bell).toHaveBeenCalledWith(
			"Sentry · needs_you",
			"Run canonical · Session owning-session",
			"warn",
			"/repo",
			expect.any(Object),
			"owning-session",
		);
		bell.mock.calls[0][4]?.onClick();
		expect(automationsUi.requestedRun()).toBe("canonical");
		expect(automationsUi.visible()).toBe(true);
		bell.mockRestore();
	});
	it("does not replay historical or unknown states into the bell", () => {
		const bell = vi.spyOn(toastsStore, "addToBell").mockReturnValue(1);
		for (const status of ["completed", "unknown", "interrupted", "skipped_precheck"] as const)
			presentAutomationNotice({ notice: true, run: { ...runFixture("old", "a1"), status } });
		presentAutomationNotice({ notice: false, run: { ...runFixture("old", "a1"), status: "failed" } });
		expect(bell).not.toHaveBeenCalled();
		bell.mockRestore();
	});
	it("native click opens the run and canonical lookup works without a saved definition", async () => {
		const run = {
			...runFixture("canonical", "deleted"),
			status: "failed" as const,
			session_id: "owner",
			stdout: { text: "saved output", truncated: false },
		};
		vi.mocked(invoke).mockResolvedValue(run);
		navigateFromNativeNotice({ kind: "automation", id: run.id });
		expect(automationsUi.requestedRun()).toBe(run.id);
		await createRoot(async (dispose) => {
			const save = vi.fn();
			const store = createAutomationsStore(fakeAdapter({ list: async () => [], save }));
			await store.openRun(run.id);
			expect(invoke).toHaveBeenCalledWith("automation_action", { input: { action: "run", id: run.id } });
			expect(store.runs()).toEqual([run]);
			expect(store.draft()).toBeUndefined();
			store.edit({ name: "Accidental historical edit" });
			await store.save();
			expect(save).not.toHaveBeenCalled();
			dispose();
		});
	});
});

// Catches: a dead creator leaving the human with an opaque failure notice.
it("legacy dead-creator failure includes its reason in the bell", () => {
	const bell = vi.spyOn(toastsStore, "addToBell").mockReturnValue(1);
	const reason = "Automation run configuration 'claude' not found";
	presentAutomationNotice({
		notice: true,
		run: { ...runFixture("pre-spawn", "a1"), status: "failed", reason, session_id: null },
	});
	expect(bell).toHaveBeenCalledWith(
		"Sentry · failed",
		expect.stringContaining(reason),
		"error",
		"/repo",
		expect.any(Object),
		undefined,
	);
	bell.mockRestore();
});

// Catches: boot remaining silent until Runs opens, and profile deletion waiting for
// another fire instead of reacting to the persisted settings event.
it("reports legacy profiles at startup and reports a new break after repair", async () => {
	const { createSettingsRefreshCoordinator } = await import("../../services/settingsRefresh");
	const { startAutomationProfileNotices } = await import("../../services/automationNotifications");
	const { definition } = await import("../automationsFixtures");
	let events: Record<string, (payload: unknown) => void> = {};
	const coordinator = createSettingsRefreshCoordinator(async (handlers) => {
		events = handlers;
		return () => {};
	});
	const bell = vi.spyOn(toastsStore, "addToBell").mockReturnValue(1);
	const invalid = [
		{
			definition: { ...definition, run_config: "claude" },
			next_run_ms: null,
			last_status: null,
			run_config_error: "Automation run configuration 'claude' not found",
		},
	];
	const list = vi.fn().mockResolvedValue(invalid);
	const stop = startAutomationProfileNotices(fakeAdapter({ list }), coordinator);
	try {
		await vi.waitFor(() => expect(bell).toHaveBeenCalledTimes(1));
		expect(bell).toHaveBeenCalledWith(
			"Sentry · configuration error",
			expect.stringContaining("claude"),
			"error",
			"/repo",
			expect.objectContaining({ label: "Fix" }),
		);
		bell.mock.calls[0][4]?.onClick();
		expect(automationsUi.requestedDefinition()).toBe("a1");
		events["settings-changed"]({ section: "agents", generation: 1, persisted: true, applied: true });
		await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));
		expect(bell).toHaveBeenCalledTimes(1);
		list.mockResolvedValueOnce([]);
		events["settings-changed"]({ section: "agents", generation: 2, persisted: true, applied: true });
		await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(3));
		events["settings-changed"]({ section: "agents", generation: 3, persisted: true, applied: true });
		await vi.waitFor(() => expect(bell).toHaveBeenCalledTimes(2));
	} finally {
		stop();
		bell.mockRestore();
	}
});
