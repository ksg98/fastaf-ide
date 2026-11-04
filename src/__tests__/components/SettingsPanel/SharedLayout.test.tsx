import { fireEvent, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it, vi } from "vitest";
import { SettingButton } from "../../../components/SettingsPanel/fields/SettingButton";
import { SettingList } from "../../../components/SettingsPanel/fields/SettingList";
import { SettingMultiSelect } from "../../../components/SettingsPanel/fields/SettingMultiSelect";
import { SettingStatus } from "../../../components/SettingsPanel/fields/SettingStatus";
import { SectionCard, SettingPageHeader } from "../../../components/SettingsPanel/SettingsPrimitives";

describe("shared Settings layout slots", () => {
	it("omits the subtitle element when optional copy is removed", () => {
		// Catches: an optional subtitle leaving an empty paragraph after page navigation.
		const [description, setDescription] = createSignal<string>();
		const view = render(() => <SettingPageHeader title="General" description={description()} />);
		const header = view.getByRole("heading", { name: "General" }).closest("header")!;
		expect(header.querySelector("p")).toBeNull();
		setDescription("Subtitle");
		expect(header.querySelector("p")?.textContent).toBe("Subtitle");
		setDescription(undefined);
		expect(header.querySelector("p")).toBeNull();
	});

	it("keeps a card action inside its named section instead of losing the action", () => {
		// Catches: SectionCard drops its actions prop, leaving callers to invent floating footers.
		const click = vi.fn();
		const view = render(() => (
			<SectionCard title="Connections" actions={<button onClick={click}>Add connection</button>}>
				<p>Existing connections</p>
			</SectionCard>
		));
		const action = view.getByRole("button", { name: "Add connection" });
		expect(action.closest("section")?.getAttribute("aria-labelledby")).toBe(
			view.getByRole("heading", { name: "Connections" }).id,
		);
		fireEvent.click(action);
		expect(click).toHaveBeenCalledOnce();
	});
	it("renders header icon and actions with the page identity", () => {
		// Catches: header slots are discarded, forcing page-specific absolute positioning.
		const view = render(() => (
			<SettingPageHeader
				title="Plugins"
				description="Manage plugins"
				scope="This machine"
				icon={<svg data-testid="page-icon" />}
				actions={<button>Documentation</button>}
			/>
		));
		const header = view.getByRole("heading", { name: "Plugins" }).closest("header")!;
		expect(header.contains(view.getByTestId("page-icon"))).toBe(true);
		expect(header.contains(view.getByRole("button", { name: "Documentation" }))).toBe(true);
	});
	it.each(["button", "status", "list", "multi"])("preserves row layout and hint association for %s fields", (kind) => {
		// Catches: composite fields silently drop row and hint IDs, mixing stacked controls into row cards.
		const view = render(() => (
			<>
				{kind === "button" && (
					<SettingButton row label="Action" hint="Decision guidance" value="Run" onClick={() => {}} />
				)}
				{kind === "status" && <SettingStatus row label="Action" hint="Decision guidance" value="Ready" />}
				{kind === "list" && (
					<SettingList row label="Action" hint="Decision guidance" rows={[]} columns={[]} onChange={() => {}} />
				)}
				{kind === "multi" && (
					<SettingMultiSelect row label="Action" hint="Decision guidance" value={[]} options={[]} onInput={() => {}} />
				)}
			</>
		));
		const control =
			kind === "button"
				? view.getByRole("button")
				: kind === "status"
					? view.getByRole("status")
					: view.getByRole("group");
		expect(control.closest('[class*="settingRowControl"]')).not.toBeNull();
		expect(control.getAttribute("aria-describedby")).toBe(view.getByText("Decision guidance").id);
	});
});
