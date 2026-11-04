import { For, Match, Show, Switch } from "solid-js";
import type { WorkItemProvider } from "../../../plugins/workItemProvider";
import type { WorkItemFieldSchema } from "../../../types/work-items.gen";
import { SettingMultiSelect } from "../../SettingsPanel/SettingFields";
import { Input } from "../../ui/Input";
import { Select } from "../../ui/Select";
import { Textarea } from "../../ui/Textarea";
import { CreateField as SettingField } from "./CreateField";
import type { DraftValue } from "./createDraft";
import { TaskCreateUser } from "./TaskCreateUser";
import styles from "./TasksCreate.module.css";

const inputType = (kind: WorkItemFieldSchema["kind"]) =>
	kind === "number" ? "number" : kind === "date" ? "date" : kind === "link" ? "url" : "text";

/** One provider-declared create field, drawn with the shared A2a setting controls. */
export function TaskCreateField(props: {
	schema: WorkItemFieldSchema;
	provider: WorkItemProvider;
	error?: string;
	value: DraftValue | undefined;
	disabled: boolean;
	onInput: (value: DraftValue) => void;
}) {
	const label = () => `${props.schema.name}${props.schema.required ? " *" : ""}`;
	const text = () => (typeof props.value === "string" ? props.value : "");
	const hint = () => (props.schema.options.length ? undefined : "The provider offers no choices for this field.");
	return (
		<Switch
			fallback={
				<SettingField label={label()} error={props.error}>
					{(id, hintId) => (
						<Input
							id={id}
							aria-describedby={hintId}
							aria-required={props.schema.required}
							aria-invalid={!!props.error}
							type={inputType(props.schema.kind)}
							step={props.schema.kind === "number" ? "any" : undefined}
							value={text()}
							disabled={props.disabled}
							onInput={(event) => props.onInput(event.currentTarget.value)}
						/>
					)}
				</SettingField>
			}
		>
			<Match when={props.schema.kind === "markdown"}>
				<SettingField label={label()} error={props.error}>
					{(id, hintId) => (
						<Textarea
							id={id}
							aria-describedby={hintId}
							aria-required={props.schema.required}
							aria-invalid={!!props.error}
							value={text()}
							disabled={props.disabled}
							onInput={(event) => props.onInput(event.currentTarget.value)}
						/>
					)}
				</SettingField>
			</Match>
			<Match when={props.schema.kind === "enum"}>
				<SettingField label={label()} error={props.error} hint={hint()}>
					{(id, hintId) => (
						<Select
							id={id}
							aria-describedby={hintId}
							aria-required={props.schema.required}
							aria-invalid={!!props.error}
							disabled={props.disabled}
							onChange={(event) => props.onInput(event.currentTarget.value)}
						>
							<option value="" selected={text() === ""}>
								Not set
							</option>
							<For each={props.schema.options}>
								{(option) => (
									<option value={option.id} selected={text() === option.id}>
										{option.name}
									</option>
								)}
							</For>
						</Select>
					)}
				</SettingField>
			</Match>
			<Match when={props.schema.kind === "user"}>
				<TaskCreateUser {...props} />
			</Match>
			<Match when={props.schema.kind === "labels" && props.schema.options.length === 0}>
				<SettingField label={label()} error={props.error} hint="Separate labels with commas.">
					{(id, hintId) => (
						<Input
							id={id}
							aria-describedby={hintId}
							aria-required={props.schema.required}
							aria-invalid={!!props.error}
							value={
								typeof props.value === "string" ? props.value : Array.isArray(props.value) ? props.value.join(",") : ""
							}
							disabled={props.disabled}
							onInput={(event) => props.onInput(event.currentTarget.value)}
						/>
					)}
				</SettingField>
			</Match>
			<Match when={props.schema.kind === "labels"}>
				<SettingMultiSelect
					label={label()}
					hint={hint()}
					disabled={props.disabled}
					value={Array.isArray(props.value) ? props.value : []}
					options={props.schema.options.map((option) => ({ value: option.id, label: option.name }))}
					onInput={props.onInput}
				/>
				<Show when={props.error}>{(error) => <p class={styles.error}>{error()}</p>}</Show>
			</Match>
		</Switch>
	);
}
