/** Dev-only fixture: mounts the production controls with synthetic, host-owned state. */
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import "../../../global.css";
import { SettingAccount } from "./SettingAccount";
import { SettingButton } from "./SettingButton";
import { SettingList, type SettingListRow } from "./SettingList";
import { SettingMultiSelect } from "./SettingMultiSelect";
import { SettingStatus } from "./SettingStatus";
import "./preview.css";

function Preview() {
	const [account, setAccount] = createSignal("work");
	const [labels, setLabels] = createSignal(["bug"]);
	const [status, setStatus] = createSignal("Connected");
	const [rows, setRows] = createSignal<SettingListRow[]>([
		{ id: "core", values: { name: "Core", key: "CORE" } },
		{ id: "mobile", values: { name: "Mobile", key: "MOB" } },
	]);
	let nextRow = 0;
	return (
		<>
			<h1>Work item settings</h1>
			<SettingAccount
				label="Account"
				provider="jira"
				value={account()}
				onInput={setAccount}
				listAccounts={async () => [{ id: "work", provider: "jira", label: "Work account" }]}
				onAdd={async () => {
					setStatus("Native account flow requested");
				}}
				hint="Credentials stay in the host vault."
			/>
			<SettingList
				label="Projects"
				rows={rows()}
				onChange={setRows}
				columns={[
					{ id: "name", label: "Name" },
					{ id: "key", label: "Key" },
				]}
				onAdd={() => ({ id: `new-${++nextRow}`, values: { name: "New project", key: "NEW" } })}
			/>
			<SettingMultiSelect
				label="Labels"
				value={labels()}
				onInput={setLabels}
				options={[
					{ value: "bug", label: "Bug" },
					{ value: "feature", label: "Feature" },
					{ value: "urgent", label: "Urgent" },
				]}
			/>
			<SettingStatus label="Connection status" value={status()} tone="success" />
			<SettingButton label="Connection" value="Test connection" onClick={() => setStatus("Connection checked")} />
		</>
	);
}

const root = document.getElementById("fields-preview");
if (root) render(() => <Preview />, root);
