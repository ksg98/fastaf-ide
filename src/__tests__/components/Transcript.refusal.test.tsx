// @vitest-environment jsdom
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it } from "vitest";
import { Transcript } from "../../components/AIChatPanel/Transcript";
import type { AcpTranscriptEntry } from "../../stores/acpTranscript";

afterEach(cleanup);
function transcript(entries: AcpTranscriptEntry[]) {
	return render(() => (
		<Transcript entries={() => entries} busy={() => false} emptyMessage="Empty" onSuggestion={() => {}} />
	));
}
describe("closed refusal turns", () => {
	it("shows ACP refusal text once as plain text — catches: generic settlement hiding the actual refusal", () => {
		const { getByRole, container } = transcript([
			{ id: "u", kind: "user", text: "Request" },
			{ id: "a", kind: "agent", text: "Cannot proceed.\nSee https://example.com." },
			{ id: "s", kind: "settled", stopReason: "refusal" },
		]);
		expect(getByRole("group", { name: "Agent refusal" }).textContent).toBe("Cannot proceed. See https://example.com.");
		expect(container.textContent?.match(/Cannot proceed/g)).toHaveLength(1);
		expect(container.querySelector("a")).toBeNull();
	});
	it("keeps a textless refusal visible — catches: empty refusal cards", () => {
		const { getByRole } = transcript([{ id: "s", kind: "settled", stopReason: "refusal" }]);
		expect(getByRole("group", { name: "Agent refusal" }).textContent).toBe("The agent refused this turn.");
	});
	it("preserves previous replies — catches: stealing a prior turn's answer for a textless refusal", () => {
		const { getByRole, container } = transcript([
			{ id: "a", kind: "agent", text: "Earlier answer" },
			{ id: "u", kind: "user", text: "Next request" },
			{ id: "s", kind: "settled", stopReason: "refusal" },
		]);
		expect(container.textContent).toContain("Earlier answer");
		expect(getByRole("group", { name: "Agent refusal" }).textContent).toBe("The agent refused this turn.");
	});
});
