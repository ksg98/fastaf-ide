import { beforeEach, describe, expect, it } from "vitest";
import { terminalsStore } from "../../stores/terminals";
import { handleIntentEvent, shouldApplyIntentTitle, shouldApplyOscTitle } from "./intentTitle";

describe("shouldApplyIntentTitle", () => {
	const base = { title: "Writing tests", globalEnabled: true, perAgentEnabled: true, nameIsCustom: false };

	it("applies the intent title under default conditions", () => {
		expect(shouldApplyIntentTitle(base)).toBe(true);
	});

	it("never overwrites a user-renamed tab", () => {
		expect(shouldApplyIntentTitle({ ...base, nameIsCustom: true })).toBe(false);
	});

	it("does nothing when the global setting is off", () => {
		expect(shouldApplyIntentTitle({ ...base, globalEnabled: false })).toBe(false);
	});

	it("does nothing when the per-agent override is off", () => {
		expect(shouldApplyIntentTitle({ ...base, perAgentEnabled: false })).toBe(false);
	});

	it("does nothing without a title", () => {
		expect(shouldApplyIntentTitle({ ...base, title: "" })).toBe(false);
		expect(shouldApplyIntentTitle({ ...base, title: null })).toBe(false);
		expect(shouldApplyIntentTitle({ ...base, title: undefined })).toBe(false);
	});
});

// An orchestrator names a spawned agent so the user can tell its tabs apart.
// Claude Code publishes its own session title over OSC 0/2 ("main-wise-beacon"),
// which used to replace that name — and, persisted through set_session_name,
// replace it for good. The agent's `intent:` title and a user rename still win.
describe("spawn name precedence", () => {
	const osc = { nameIsCustom: false, nameFromSpawn: false, agentIntent: null, intentTabTitle: true };

	it("lets an OSC title replace a default name", () => {
		expect(shouldApplyOscTitle(osc)).toBe(true);
	});

	it("never lets an OSC title replace a spawn name", () => {
		expect(shouldApplyOscTitle({ ...osc, nameFromSpawn: true })).toBe(false);
	});

	it("never lets an OSC title replace a user rename", () => {
		expect(shouldApplyOscTitle({ ...osc, nameIsCustom: true })).toBe(false);
	});

	it("lets an intent title hold the name against OSC only while intent titles are enabled", () => {
		expect(shouldApplyOscTitle({ ...osc, agentIntent: "Fixing" })).toBe(false);
		expect(shouldApplyOscTitle({ ...osc, agentIntent: "Fixing", intentTabTitle: false })).toBe(true);
	});

	describe("through the store", () => {
		beforeEach(() => {
			for (const id of terminalsStore.getIds()) terminalsStore.remove(id);
		});

		it("an intent title still refines a spawn name", () => {
			const id = terminalsStore.add({
				sessionId: null,
				fontSize: 14,
				name: "call-map",
				cwd: null,
				awaitingInput: null,
				nameFromSpawn: true,
			});
			handleIntentEvent({
				terminalId: id,
				text: "Mapping calls",
				title: "Call mapping",
				globalEnabled: true,
				perAgentEnabled: true,
			});
			expect(terminalsStore.get(id)?.name).toBe("Call mapping");
		});

		it("a user rename still replaces a spawn name, and then outranks the intent title", () => {
			const id = terminalsStore.add({
				sessionId: null,
				fontSize: 14,
				name: "call-map",
				cwd: null,
				awaitingInput: null,
				nameFromSpawn: true,
			});
			terminalsStore.update(id, { name: "mine", nameIsCustom: true });
			handleIntentEvent({
				terminalId: id,
				text: "Mapping calls",
				title: "Call mapping",
				globalEnabled: true,
				perAgentEnabled: true,
			});
			expect(terminalsStore.get(id)?.name).toBe("mine");
		});
	});
});
