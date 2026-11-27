import { createSignal, createUniqueId, For, Show } from "solid-js";
import { IconUndo } from "../icons";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { Textarea } from "../ui/Textarea";
import type { FieldSchema, JsonValue, ObjectSchema } from "./catalogTypes";
import s from "./WorkflowDesigner.module.css";

/** Edits literals only. Backend resolves defaults and validates the declared type. */
export function SchemaFields(props: {
	schema: ObjectSchema;
	values: Record<string, JsonValue>;
	onChange: (values: Record<string, JsonValue>) => void;
}) {
	const set = (name: string, value: JsonValue) => props.onChange({ ...props.values, [name]: value });
	const unset = (name: string) => {
		const { [name]: _removed, ...rest } = props.values;
		props.onChange(rest);
	};
	return (
		<For each={Object.entries(props.schema.fields)}>
			{([name, schema]) => {
				const id = createUniqueId();
				const value = () => (Object.hasOwn(props.values, name) ? props.values[name] : schema.default);
				return (
					<div class={s.field}>
						{/* The name, its type, and one quiet way back to the default. */}
						<div class={s.fieldHead}>
							<label for={id}>{name}</label>
							<span class={s.fieldType}>
								{schema.value_type}
								{schema.required ? " · required" : ""}
							</span>
							<button
								type="button"
								class={s.resetBtn}
								aria-label={`Use default / unset ${name}`}
								title="Use the default"
								onClick={() => unset(name)}
								disabled={!Object.hasOwn(props.values, name)}
							>
								<IconUndo size={14} />
							</button>
						</div>
						<Show
							when={schema.value_type === "string"}
							fallback={
								<Show
									when={schema.value_type === "boolean"}
									fallback={
										<JsonField
											id={id}
											name={name}
											schema={schema}
											value={value()}
											onChange={(next) => set(name, next)}
										/>
									}
								>
									<Select
										id={id}
										aria-label={name}
										value={value() === null ? "" : String(value())}
										onChange={(event) => {
											if (event.currentTarget.value === "") unset(name);
											else set(name, event.currentTarget.value === "true");
										}}
									>
										<option value="">Default</option>
										<option value="true">True</option>
										<option value="false">False</option>
									</Select>
								</Show>
							}
						>
							<Input
								id={id}
								aria-label={name}
								value={typeof value() === "string" ? String(value()) : ""}
								onInput={(event) => set(name, event.currentTarget.value)}
							/>
						</Show>
					</div>
				);
			}}
		</For>
	);
}

function JsonField(props: {
	id: string;
	name: string;
	schema: FieldSchema;
	value: JsonValue;
	onChange: (value: JsonValue) => void;
}) {
	const [error, setError] = createSignal("");
	return (
		<>
			<Textarea
				id={props.id}
				class={s.codeInput}
				aria-label={props.name}
				value={JSON.stringify(props.value, null, 2)}
				onChange={(event) => {
					try {
						const value: JsonValue = JSON.parse(event.currentTarget.value);
						props.onChange(value);
						setError("");
					} catch {
						setError(`${props.name}: enter valid JSON for ${props.schema.value_type}`);
					}
				}}
			/>
			<Show when={error()}>
				<span role="alert" class={s.fieldError}>
					{error()}
				</span>
			</Show>
		</>
	);
}
