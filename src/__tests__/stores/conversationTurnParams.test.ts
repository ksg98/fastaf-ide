import { describe, expect, it } from "vitest";
import { turnParams } from "../../stores/conversationStore";

describe("turnParams", () => {
	it("omits both keys when nothing is chosen", () => {
		// An unset picker must not override the model's configured effort or the
		// global AI-chat setting — the backend only falls back on absent fields.
		expect(turnParams()).toEqual({});
		expect(turnParams({})).toEqual({});
		expect(turnParams({ modelOverride: "", reasoningEffort: "" })).toEqual({});
		expect(turnParams({ modelOverride: "   ", reasoningEffort: "  " })).toEqual({});
	});

	it("forwards chosen values under the names the Tauri command expects", () => {
		expect(turnParams({ modelOverride: "gpt-5.6-terra", reasoningEffort: "xhigh" })).toEqual({
			modelOverride: "gpt-5.6-terra",
			reasoningEffort: "xhigh",
		});
	});

	it("forwards each field independently", () => {
		expect(turnParams({ reasoningEffort: "high" })).toEqual({ reasoningEffort: "high" });
		expect(turnParams({ modelOverride: "gpt-5.5" })).toEqual({ modelOverride: "gpt-5.5" });
	});

	it("passes 'off' through — it is a real choice, not an absent one", () => {
		expect(turnParams({ reasoningEffort: "off" })).toEqual({ reasoningEffort: "off" });
	});
});
