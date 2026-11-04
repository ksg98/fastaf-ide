import { fireEvent, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it } from "vitest";
import { Input } from "../../ui/Input";
import { DangerZone, SectionCard, SettingRow, StatusSummary } from "../SettingsPrimitives";
import { SettingsShell } from "../SettingsShell";

describe("Settings presentation contract", () => {
	// Catches: row restyling loses the input label or leaves validation inaccessible.
	it("associates the existing control with its label, hint and changing error", () => {
		const [error, setError] = createSignal<string>();
		const [value, setValue] = createSignal("draft");
		const view = render(() => (
			<SectionCard title="Workspace">
				<SettingRow label="Folder" hint="New runs only" error={error()}>
					{(id, descriptionId) => (
						<Input
							id={id}
							aria-describedby={descriptionId()}
							value={value()}
							onInput={(event) => setValue(event.currentTarget.value)}
						/>
					)}
				</SettingRow>
			</SectionCard>
		));
		const input = view.getByLabelText("Folder") as HTMLInputElement;
		fireEvent.input(input, { target: { value: "kept draft" } });
		setError("Could not save folder");
		expect(input.value).toBe("kept draft");
		const descriptions = input
			.getAttribute("aria-describedby")!
			.split(" ")
			.map((id) => document.getElementById(id)?.textContent);
		expect(descriptions).toEqual(["New runs only", "Could not save folder"]);
		setError(undefined);
		expect(input.getAttribute("aria-describedby")!.split(" ")).toHaveLength(1);
		expect(view.getByRole("region", { name: "Workspace" })).toBeTruthy();
	});

	// Catches: neutral unknown status gets presented as a verified success.
	it("retains the caller's unknown status, source and freshness without inference", () => {
		const view = render(() => (
			<StatusSummary label="Status not available" source="Last configuration read" freshness="Not checked" />
		));
		expect(view.getByRole("status").textContent).toContain("Last configuration read · Not checked");
		expect(view.getByText("Status not available").getAttribute("data-variant")).toBe("default");
	});

	// Catches: shared danger presentation executes a mutation or invents confirmation.
	it("leaves destructive action and confirmation ownership with the caller", () => {
		let calls = 0;
		const view = render(() => (
			<DangerZone title="Disconnect" scope="This connection" consequence="Active clients disconnect.">
				<button onClick={() => calls++}>Review disconnect</button>
			</DangerZone>
		));
		expect(calls).toBe(0);
		fireEvent.click(view.getByRole("button", { name: "Review disconnect" }));
		expect(calls).toBe(1);
	});
	// Catches: compact navigation offers group headings as pages or selects a different page without notifying its owner.
	it("routes the compact page selector through the existing tab callback", () => {
		let selected = "";
		const view = render(() => (
			<SettingsShell
				visible
				title="Settings"
				onClose={() => {}}
				activeTab="general"
				onTabChange={(key) => {
					selected = key;
				}}
				tabs={[
					{ key: "__label__:app", label: "Application" },
					{ key: "general", label: "General" },
					{ key: "__sep__", label: "" },
					{ key: "appearance", label: "Appearance" },
				]}
			>
				<p>Existing page</p>
			</SettingsShell>
		));
		const select = view.getByRole("combobox", { name: "Settings page" });
		expect(select).toHaveValue("general");
		expect(view.queryByRole("option", { name: "Application" })).toBeNull();
		fireEvent.change(select, { target: { value: "appearance" } });
		expect(selected).toBe("appearance");
	});
});

// Catches: the card heading slot drops contextual help or nests an interactive help trigger in the heading label.
it("keeps card help next to its heading without changing the region name", () => {
	const view = render(() => (
		<SectionCard title="Local tools" help={<button>Explain tools</button>}>
			<p>Tools</p>
		</SectionCard>
	));
	const heading = view.getByRole("heading", { name: "Local tools" });
	expect(heading.parentElement).toBe(view.getByRole("button", { name: "Explain tools" }).parentElement);
	expect(view.getByRole("region", { name: "Local tools" })).toBeTruthy();
});
// Catches: adding banner details moves existing caller-owned status actions into the text column.
it("keeps status details separate from legacy and named actions", () => {
	const view = render(() => (
		<StatusSummary
			label="Not checked"
			source="Local configuration"
			details={<p>Check explicitly</p>}
			actions={<button>Check now</button>}
		>
			<button>Existing action</button>
		</StatusSummary>
	));
	const detail = view.getByText("Check explicitly");
	expect(detail.parentElement).not.toContainElement(view.getByRole("button", { name: "Check now" }));
	expect(detail.parentElement).not.toContainElement(view.getByRole("button", { name: "Existing action" }));
});

// Catches: absolutely positioned card actions overlap the description on compact screens.
it("keeps heading actions in the shared heading layout before the description", () => {
	const view = render(() => (
		<SectionCard title="Upstreams" description="Proxy external servers" headingActions={<button>Add server</button>}>
			<p>Existing content</p>
		</SectionCard>
	));
	const heading = view.getByRole("heading", { name: "Upstreams" });
	const action = view.getByRole("button", { name: "Add server" });
	expect(heading.parentElement).toContainElement(action);
	expect(heading.parentElement?.nextElementSibling).toBe(view.getByText("Proxy external servers"));
	expect(view.getByRole("region", { name: "Upstreams" })).toBeTruthy();
});
