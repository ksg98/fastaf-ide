import { type Component, For } from "solid-js";
import s from "./fields.module.css";
import { SettingField, type SettingFieldProps } from "./SettingField";

export interface SettingMultiSelectProps extends SettingFieldProps {
	value: readonly string[];
	options: readonly { value: string; label: string }[];
	onInput: (value: string[]) => unknown;
}

export const SettingMultiSelect: Component<SettingMultiSelectProps> = (props) => (
	<SettingField
		settingId={props.settingId}
		data-setting-id={props["data-setting-id"]}
		label={props.label}
		hint={props.hint}
		row={props.row}
		error={props.error}
		help={props.help}
		actions={props.actions}
	>
		{(id, _hintId, descriptionId) => (
			<div id={id} role="group" aria-label={props.label} aria-describedby={descriptionId()} class={s.choices}>
				<For each={props.options}>
					{(option) => (
						<label class={s.choice}>
							<input
								data-setting-id={props.settingId ?? props["data-setting-id"]}
								type="checkbox"
								checked={props.value.includes(option.value)}
								disabled={props.disabled}
								onChange={(e) =>
									props.onInput(
										e.currentTarget.checked
											? [...props.value, option.value]
											: props.value.filter((value) => value !== option.value),
									)
								}
							/>
							<span>{option.label}</span>
						</label>
					)}
				</For>
			</div>
		)}
	</SettingField>
);
