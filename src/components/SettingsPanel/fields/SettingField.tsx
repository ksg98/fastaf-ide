import { type Component, createUniqueId, type JSX, Show } from "solid-js";
import { type SettingId, settingHint, settingLabel } from "../../../services/settingsCatalogue";
import { ContextualHelp } from "../ContextualHelp";
import s from "../Settings.module.css";

export interface SettingFieldProps {
	label: string;
	settingId?: SettingId;
	"data-setting-id"?: string;
	hint?: string;
	error?: string;
	help?: JSX.Element;
	actions?: JSX.Element;
	row?: boolean;
	disabled?: boolean;
}

export const SettingField: Component<
	SettingFieldProps & {
		children: (id: string, hintId: string | undefined, descriptionId: () => string | undefined) => JSX.Element;
	}
> = (props) => {
	const id = createUniqueId();
	const descriptionId = () =>
		[props.hint && `${id}-hint`, props.error && `${id}-error`].filter(Boolean).join(" ") || undefined;
	return (
		<Show
			when={props.row}
			fallback={
				<div class={s.group} data-setting-id={props.settingId ?? props["data-setting-id"]}>
					<div class={s.helpLabel}>
						<label for={id}>{settingLabel(props.settingId, props.label)}</label>
						{props.help || (
							<ContextualHelp
								label={settingLabel(props.settingId, props.label)}
								hint={settingHint(props.settingId, props.hint)}
							/>
						)}
					</div>
					{props.children(id, descriptionId(), descriptionId)}
					<Show when={settingHint(props.settingId, props.hint)}>
						<p id={`${id}-hint`} class={s.hint}>
							{settingHint(props.settingId, props.hint)}
						</p>
					</Show>
					<Show when={props.error}>
						<p id={`${id}-error`} class={s.fieldError} role="alert">
							{props.error}
						</p>
					</Show>
				</div>
			}
		>
			<div class={s.settingRow} data-setting-id={props.settingId ?? props["data-setting-id"]}>
				<div class={s.settingRowText}>
					<div class={s.helpLabel}>
						<label for={id}>{settingLabel(props.settingId, props.label)}</label>
						{props.help || (
							<ContextualHelp
								label={settingLabel(props.settingId, props.label)}
								hint={settingHint(props.settingId, props.hint)}
							/>
						)}
					</div>
					<Show when={settingHint(props.settingId, props.hint)}>
						<p id={`${id}-hint`} class={s.hint}>
							{settingHint(props.settingId, props.hint)}
						</p>
					</Show>
				</div>
				<div class={s.settingRowControl} classList={{ [s.settingRowWithActions]: !!props.actions }}>
					<Show when={props.actions} fallback={props.children(id, undefined, descriptionId)}>
						<div class={s.settingRowValue}>{props.children(id, undefined, descriptionId)}</div>
						{props.actions}
					</Show>
					<Show when={props.error}>
						<p id={`${id}-error`} class={s.fieldError} role="alert">
							{props.error}
						</p>
					</Show>
				</div>
			</div>
		</Show>
	);
};
