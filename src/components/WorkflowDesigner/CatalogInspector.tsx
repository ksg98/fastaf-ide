import { For, Show } from "solid-js";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import type { ActivityDescriptor, ActivityInstance, ObjectSchema } from "./catalogTypes";
import { SchemaFields } from "./SchemaFields";
import s from "./WorkflowDesigner.module.css";

/** A schema as name · type rows; read only. */
function SchemaList(props: { title: string; schema: ObjectSchema }) {
	return (
		<Show when={Object.keys(props.schema.fields).length}>
			<h5 class={s.label}>{props.title}</h5>
			<dl class={s.facts}>
				<For each={Object.entries(props.schema.fields)}>
					{([name, field]) => (
						<>
							<dt>{name}</dt>
							<dd>
								{field.value_type}
								{field.required ? "" : " · optional"}
							</dd>
						</>
					)}
				</For>
			</dl>
		</Show>
	);
}

/** No operation-name branches: custom scripts use the same descriptor form. */
export function CatalogInspector(props: {
	descriptor: ActivityDescriptor;
	instance: ActivityInstance;
	label: string;
	onLabel: (label: string) => void;
	onChange: (instance: ActivityInstance) => void;
}) {
	return (
		<section class={s.block} aria-label="Catalog activity inspector">
			<div>
				<p class={s.purpose}>{props.descriptor.purpose}</p>
				<p class={s.muted}>
					{props.descriptor.id.namespace}.{props.descriptor.id.name} · version {props.descriptor.id.version}
				</p>
			</div>
			<label class={s.field}>
				Label
				<Input
					aria-label="Activity label"
					value={props.label}
					onInput={(event) => props.onLabel(event.currentTarget.value)}
				/>
			</label>
			<Show when={Object.keys(props.descriptor.config.fields).length}>
				<h5 class={s.label}>Configuration</h5>
				<SchemaFields
					schema={props.descriptor.config}
					values={props.instance.config}
					onChange={(config) => props.onChange({ ...props.instance, config })}
				/>
			</Show>
			<label class={s.field}>
				Execution policy
				<Select
					aria-label="Execution policy"
					value={props.instance.execution_policy}
					onChange={(event) => props.onChange({ ...props.instance, execution_policy: event.currentTarget.value })}
				>
					<option value="">Choose policy</option>
					<For each={props.descriptor.execution_policies}>{(policy) => <option value={policy}>{policy}</option>}</For>
				</Select>
			</label>
			{/* What the catalog says about it: read only, so it stays folded. */}
			<details class={s.disclosure}>
				<summary>About this activity</summary>
				<h5 class={s.label}>Outcomes</h5>
				<p class={s.chips}>
					<For each={props.descriptor.outcomes}>{(outcome) => <span class={s.chip}>{outcome}</span>}</For>
				</p>
				<h5 class={s.label}>Required capabilities</h5>
				<Show when={props.descriptor.required_capabilities.length} fallback={<p class={s.muted}>None</p>}>
					<p class={s.chips}>
						<For each={props.descriptor.required_capabilities}>
							{(capability) => <span class={s.chip}>{capability}</span>}
						</For>
					</p>
				</Show>
				<SchemaList title="Inputs" schema={props.descriptor.inputs} />
				<SchemaList title="Outputs" schema={props.descriptor.outputs} />
				<Show when={props.descriptor.subject}>
					{(subject) => (
						<>
							<h5 class={s.label}>Subject</h5>
							<pre class={s.code}>{JSON.stringify(subject(), null, 2)}</pre>
						</>
					)}
				</Show>
				<h5 class={s.label}>Descriptor</h5>
				<pre class={s.code}>{JSON.stringify(props.descriptor, null, 2)}</pre>
			</details>
		</section>
	);
}
