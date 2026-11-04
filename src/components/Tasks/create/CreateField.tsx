import { type JSX, Show } from "solid-js";
import { SettingField } from "../../SettingsPanel/fields/SettingField";
import styles from "./TasksCreate.module.css";

/** Keep the control mounted when its error changes, so validation never interrupts typing. */
export function CreateField(props: {
	label: string;
	hint?: string;
	error?: string;
	children: (id: string, descriptionId: string) => JSX.Element;
}) {
	return (
		<SettingField label={props.label} hint={props.hint}>
			{(id, hintId) => (
				<>
					{props.children(id, [hintId, `${id}-error`].filter(Boolean).join(" "))}
					<Show when={props.error}>
						{(error) => (
							<p id={`${id}-error`} class={styles.error}>
								{error()}
							</p>
						)}
					</Show>
				</>
			)}
		</SettingField>
	);
}
