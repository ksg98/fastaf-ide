import { fireEvent, render } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import { contextualHelp, SettingsHelpScope } from "../../../components/SettingsPanel/ContextualHelp";
import { SettingRow } from "../../../components/SettingsPanel/SettingsPrimitives";

describe("selective contextual help", () => {
	// Catches: a generic help badge repeats every subtitle, including rows excluded by the approved inventory.
	it("renders approved extra guidance only in its page scope", () => {
		const view = render(() => (
			<SettingsHelpScope page="general">
				<SettingRow label="Language" hint="Interface language">
					{(id) => <input id={id} />}
				</SettingRow>
				<SettingRow label="Content Indexing" hint="When to index">
					{(id) => <input id={id} />}
				</SettingRow>
			</SettingsHelpScope>
		));
		expect(view.queryByRole("button", { name: "Explain Language" })).toBeNull();
		expect(view.getByRole("button", { name: "Explain Content Indexing" })).toBeTruthy();
		expect(contextualHelp("voice", "Content Indexing")).toBeUndefined();
		const copy = contextualHelp("general", "Content Indexing")!;
		expect(contextualHelp("general", "Content Indexing", copy)).toBeUndefined();
		view.unmount();
	});
	// Catches: touch-pinned help disappears on pointer exit or remains visible after Escape/outside dismissal.
	it("pins on click, measures before display, and dismisses without changing the input", () => {
		const view = render(() => (
			<SettingsHelpScope page="general">
				<SettingRow label="Content Indexing">{(id) => <input id={id} value="unchanged" />}</SettingRow>
			</SettingsHelpScope>
		));
		const badge = view.getByRole("button", { name: "Explain Content Indexing" });
		const tip = view.getByRole("tooltip");
		expect(tip.getAttribute("data-visible")).toBeNull();
		fireEvent.click(badge);
		fireEvent.mouseLeave(badge);
		fireEvent.blur(badge);
		expect(tip.getAttribute("data-visible")).toBe("true");
		expect(tip.style.left).not.toBe("");
		fireEvent.keyDown(document, { key: "Escape" });
		expect(tip.getAttribute("data-visible")).toBeNull();
		fireEvent.keyDown(badge, { key: "Enter" });
		expect(tip.getAttribute("data-visible")).toBe("true");
		fireEvent.pointerDown(document.body);
		expect(tip.getAttribute("data-visible")).toBeNull();
		expect((view.getByRole("textbox") as HTMLInputElement).value).toBe("unchanged");
		view.unmount();
	});
});
