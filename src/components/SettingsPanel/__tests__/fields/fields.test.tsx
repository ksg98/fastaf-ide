import { fireEvent, render, waitFor, within } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it } from "vitest";
import {
	SettingAccount,
	SettingButton,
	SettingList,
	type SettingListRow,
	SettingMultiSelect,
	SettingStatus,
} from "../../SettingFields";

describe("setting field controls", () => {
	// Catches: index-keyed removal deletes another row after a reorder, or editing drops sibling cells.
	it("SettingList_remove_row_keeps_other_rows", () => {
		const [rows, setRows] = createSignal<SettingListRow[]>([
			{ id: "alpha", values: { name: "Alpha", project: "A" } },
			{ id: "beta", values: { name: "Beta", project: "B" } },
			{ id: "gamma", values: { name: "Gamma", project: "C" } },
		]);
		const view = render(() => (
			<SettingList
				label="Projects"
				rows={rows()}
				onChange={setRows}
				columns={[
					{ id: "name", label: "Name" },
					{ id: "project", label: "Project" },
				]}
				onAdd={() => ({ id: "delta", values: { name: "Delta", project: "D" } })}
			/>
		));
		setRows([rows()[2], rows()[0], rows()[1]]);
		fireEvent.input(within(view.getByRole("group", { name: "Row beta" })).getByLabelText("Name"), {
			target: { value: "Changed" },
		});
		fireEvent.click(view.getByRole("button", { name: "Remove row alpha" }));
		expect(view.queryByRole("group", { name: "Row alpha" })).toBeNull();
		expect(within(view.getByRole("group", { name: "Row beta" })).getByLabelText("Name")).toHaveValue("Changed");
		expect(within(view.getByRole("group", { name: "Row beta" })).getByLabelText("Project")).toHaveValue("B");
		expect(within(view.getByRole("group", { name: "Row gamma" })).getByLabelText("Name")).toHaveValue("Gamma");
		fireEvent.click(view.getByRole("button", { name: "Add row" }));
		expect(within(view.getByRole("group", { name: "Row delta" })).getByLabelText("Name")).toHaveValue("Delta");
	});

	// Catches: checkbox changes discard other selections or cannot remove an existing selection.
	it("multiselect_keeps_other_selected_values", () => {
		const [value, setValue] = createSignal(["bug"]);
		const view = render(() => (
			<SettingMultiSelect
				label="Labels"
				value={value()}
				onInput={setValue}
				options={[
					{ value: "bug", label: "Bug" },
					{ value: "feature", label: "Feature" },
				]}
			/>
		));
		fireEvent.click(view.getByLabelText("Feature"));
		expect(view.getByLabelText("Bug")).toBeChecked();
		expect(view.getByLabelText("Feature")).toBeChecked();
		fireEvent.click(view.getByLabelText("Bug"));
		expect(view.getByLabelText("Bug")).not.toBeChecked();
		expect(view.getByLabelText("Feature")).toBeChecked();
	});

	// Catches: a button submits the surrounding form or still runs while disabled.
	it("button_runs_action_without_submitting_form_and_respects_disabled", () => {
		const [value, setValue] = createSignal("Not run");
		const [disabled, setDisabled] = createSignal(false);
		const view = render(() => (
			<form
				onSubmit={(e) => {
					e.preventDefault();
					setValue("Submitted");
				}}
			>
				<SettingButton
					label="Connection"
					value="Test connection"
					disabled={disabled()}
					onClick={() => setValue("Connected")}
				/>
				<SettingStatus label="Status" value={value()} tone="success" />
			</form>
		));
		fireEvent.click(view.getByRole("button", { name: "Test connection" }));
		expect(view.getByRole("status", { name: "Status" })).toHaveTextContent("Connected");
		setValue("Not run");
		setDisabled(true);
		fireEvent.click(view.getByRole("button", { name: "Test connection" }));
		expect(view.getByRole("status", { name: "Status" })).toHaveTextContent("Not run");
	});

	// Catches: a read-only status becomes editable or communicates state only through colour.
	it("status_renders_read_only_text_and_updates", () => {
		const [value, setValue] = createSignal("Offline");
		const view = render(() => (
			<SettingStatus label="Service" value={value()} tone="warning" hint="Current connection" />
		));
		expect(view.getByRole("status", { name: "Service" })).toHaveTextContent("Offline");
		expect(view.queryByRole("textbox")).toBeNull();
		setValue("Online");
		expect(view.getByRole("status", { name: "Service" })).toHaveTextContent("Online");
	});

	// Catches: spreading an account view into markup exposes secret fields or another provider's accounts.
	it("SettingAccount_never_renders_secret", async () => {
		const [value, setValue] = createSignal("");
		const extra = {
			id: "one",
			provider: "jira",
			label: "Work",
			secret: { status: "set", token: "SENSITIVE-SENTINEL" },
		};
		const view = render(() => (
			<SettingAccount
				label="Account"
				provider="jira"
				value={value()}
				onInput={setValue}
				listAccounts={async () => [extra, { id: "two", provider: "github", label: "Other provider" }]}
				onAdd={async () => {
					throw new Error("SENSITIVE-SENTINEL");
				}}
			/>
		));
		await waitFor(() => expect(view.getByRole("option", { name: "Work" })).toBeInTheDocument());
		fireEvent.change(view.getByLabelText("Account"), { target: { value: "one" } });
		expect(view.getByLabelText("Account")).toHaveValue("one");
		expect(view.queryByRole("option", { name: "Other provider" })).toBeNull();
		fireEvent.click(view.getByRole("button", { name: "Add account" }));
		await waitFor(() => expect(view.getByRole("alert")).toBeInTheDocument());
		expect(view.container.innerHTML).not.toContain("SENSITIVE-SENTINEL");
		expect(view.queryByDisplayValue("SENSITIVE-SENTINEL")).toBeNull();
	});

	// Catches: adding an account leaves the select stale, or changing providers retains old choices.
	it("account_add_reloads_choices_and_provider_change_removes_old_choices", async () => {
		const accounts = [{ id: "one", provider: "jira", label: "Work" }];
		const [provider, setProvider] = createSignal("jira");
		const view = render(() => (
			<SettingAccount
				label="Account"
				provider={provider()}
				value=""
				onInput={() => {}}
				listAccounts={async () => [...accounts]}
				onAdd={async (id) => {
					accounts.push({ id: "new", provider: id, label: "Added" });
				}}
			/>
		));
		await waitFor(() => expect(view.getByRole("option", { name: "Work" })).toBeInTheDocument());
		fireEvent.click(view.getByRole("button", { name: "Add account" }));
		await waitFor(() => expect(view.getByRole("option", { name: "Added" })).toBeInTheDocument());
		setProvider("github");
		await waitFor(() => expect(view.queryByRole("option", { name: "Work" })).toBeNull());
	});

	// Catches: failed list requests expose backend errors or leave no recovery action.
	it("account_load_failure_is_safe_and_retry_recovers", async () => {
		let fail = true;
		const view = render(() => (
			<SettingAccount
				label="Account"
				provider="jira"
				value=""
				onInput={() => {}}
				onAdd={async () => {}}
				listAccounts={async () => {
					if (fail) throw new Error("SENSITIVE-SENTINEL");
					return [{ id: "one", provider: "jira", label: "Recovered" }];
				}}
			/>
		));
		await waitFor(() => expect(view.getByRole("alert")).toBeInTheDocument());
		expect(view.container.innerHTML).not.toContain("SENSITIVE-SENTINEL");
		fail = false;
		fireEvent.click(view.getByRole("button", { name: "Retry" }));
		await waitFor(() => expect(view.getByRole("option", { name: "Recovered" })).toBeInTheDocument());
		expect(view.queryByRole("alert")).toBeNull();
	});
});
