import { type Component, For, Show } from "solid-js";
import { remoteConnectionsStore } from "../../stores/remoteConnections";
import { Select } from "../ui/Select";
import s from "./Settings.module.css";

interface MachineSelectorProps {
	/** The connection whose config is being edited; `undefined` is this machine. */
	value: string | undefined;
	onChange: (connectionId: string | undefined) => void;
	/** What the setting is, so the label reads as a sentence. */
	label?: string;
}

/**
 * Pick which machine a settings tab reads and writes.
 *
 * Run configs, MCP upstreams and the agent hooks describe the box that runs the
 * agents, so every tab in that family has to say which box it is showing. Before
 * this, the machine was implied by whichever repository the user had selected in
 * the settings nav, which cannot express "edit the VPS while I stand on a local
 * repo" — and silently showed the Mac's config when it could not.
 *
 * Renders nothing when no remote connection is registered: there is one machine,
 * and a one-entry dropdown is noise.
 */
export const MachineSelector: Component<MachineSelectorProps> = (props) => {
	const connections = () => Object.values(remoteConnectionsStore.getConnections());

	return (
		<Show when={connections().length > 0}>
			<div class={s.group}>
				<label for="machine-selector">{props.label ?? "Machine"}</label>
				<Select
					data-non-setting="Select the machine whose settings are displayed"
					id="machine-selector"
					class={s.input}
					value={props.value ?? ""}
					onChange={(e) => props.onChange(e.currentTarget.value || undefined)}
				>
					<option value="">This machine</option>
					<For each={connections()}>
						{(conn) => (
							<option value={conn.connection.id}>
								{conn.connection.name}
								{conn.status === "connected" ? "" : ` (${conn.status})`}
							</option>
						)}
					</For>
				</Select>
			</div>
		</Show>
	);
};
