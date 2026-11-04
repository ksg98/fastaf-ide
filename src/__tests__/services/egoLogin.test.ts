import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../mocks/tauri";

import { egoLoginCommand, startEgoLogin } from "../../services/egoLogin";
import { settingsStore } from "../../stores/settings";
import { terminalsStore } from "../../stores/terminals";

/**
 * `ego auth login PROVIDER` prompts for a browser round trip, a device code or
 * an API key. It is run by the person in a terminal tab, so what is asserted is
 * only the command that reaches that tab and when the tab is reported finished.
 */
describe("egoLoginCommand", () => {
	it("names the configured binary, the subcommand and exactly one provider argument", () => {
		expect(egoLoginCommand("/opt/ego/bin/ego", "kimi-coding")).toBe("'/opt/ego/bin/ego' auth login 'kimi-coding'");
	});

	it("keeps a hostile provider name as one inert argument", () => {
		expect(egoLoginCommand("/bin/ego", "x'; rm -rf ~; '")).toBe("'/bin/ego' auth login 'x'\\''; rm -rf ~; '\\'''");
	});
});

describe("startEgoLogin", () => {
	beforeEach(() => {
		settingsStore.setEgoExecutable("/opt/ego/bin/ego");
	});
	afterEach(() => {
		for (const id of terminalsStore.getIds()) terminalsStore.remove(id);
	});

	it("opens a focused terminal tab that will type the login command", () => {
		const id = startEgoLogin("anthropic", vi.fn());
		const tab = terminalsStore.get(id);
		expect(tab?.pendingInitCommand).toBe("'/opt/ego/bin/ego' auth login 'anthropic'");
		expect(tab?.name).toBe("ego login anthropic");
		expect(tab?.nameIsCustom).toBe(true);
		expect(terminalsStore.state.activeId).toBe(id);
	});

	it("reports the end only after the command ran and the shell went idle again", async () => {
		const done = vi.fn();
		const id = startEgoLogin("openai", done);
		// The shell's own first prompt is idle; that is before the command.
		terminalsStore.update(id, { shellState: "idle" });
		await Promise.resolve();
		expect(done).not.toHaveBeenCalled();
		terminalsStore.update(id, { shellState: "busy" });
		await Promise.resolve();
		expect(done).not.toHaveBeenCalled();
		terminalsStore.update(id, { shellState: "idle" });
		await Promise.resolve();
		expect(done).toHaveBeenCalledTimes(1);
		// Later shell activity in the same tab is not another login.
		terminalsStore.update(id, { shellState: "busy" });
		terminalsStore.update(id, { shellState: "idle" });
		await Promise.resolve();
		expect(done).toHaveBeenCalledTimes(1);
	});

	it("reports the end when the tab is closed before the command finishes", async () => {
		const done = vi.fn();
		const id = startEgoLogin("gemini", done);
		terminalsStore.update(id, { shellState: "busy" });
		terminalsStore.remove(id);
		await Promise.resolve();
		expect(done).toHaveBeenCalledTimes(1);
	});

	it("refuses to start without a configured binary", () => {
		settingsStore.setEgoExecutable("");
		expect(() => startEgoLogin("anthropic", vi.fn())).toThrow(/ego executable/);
		expect(terminalsStore.getIds()).toHaveLength(0);
	});
});
