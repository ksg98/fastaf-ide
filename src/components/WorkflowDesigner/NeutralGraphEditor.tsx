import { For, type JSX, Show } from "solid-js";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import type { ActivityDescriptor } from "./catalogTypes";
import type { ControlNode, NeutralDefinition } from "./neutralClient";
import s from "./WorkflowDesigner.module.css";

interface GraphProps {
	definition: NeutralDefinition;
	activities: ActivityDescriptor[];
	labels: Record<string, string>;
	onChange: (definition: NeutralDefinition) => void;
}

/** The kinds of step a person can add; activities come from the catalog. */
const ADDABLE: { value: string; label: string; node: () => ControlNode }[] = [
	{ value: "wait", label: "Wait", node: () => ({ type: "wait", duration_ms: 1000 }) },
	{ value: "condition", label: "Condition", node: () => ({ type: "condition", condition: "" }) },
	{ value: "fork", label: "Fork", node: () => ({ type: "fork", scope: "" }) },
	{ value: "collection", label: "Collection", node: () => ({ type: "collection", scope: "" }) },
	{ value: "loop", label: "Loop", node: () => ({ type: "loop", scope: "", condition: "" }) },
	{ value: "end", label: "End", node: () => ({ type: "end", outcome: "completed" }) },
];

const KIND: Record<ControlNode["type"], string> = {
	start: "Start",
	end: "End",
	activity: "Activity",
	condition: "Condition",
	collection: "Collection",
	fork: "Fork",
	loop: "Loop",
	wait: "Wait",
};

const descriptorOf = (props: Pick<GraphProps, "definition" | "activities">, node: ControlNode) => {
	if (node.type !== "activity") return undefined;
	const instance = props.definition.instances[node.activity];
	return props.activities.find(
		(entry) =>
			entry.id.namespace === instance?.descriptor.namespace &&
			entry.id.name === instance?.descriptor.name &&
			entry.id.version === instance?.descriptor.version,
	);
};

/** What a step is, in a few words: its kind, and for an activity which one. */
export function stepKind(props: Pick<GraphProps, "definition">, node: ControlNode | undefined): string {
	if (!node) return "";
	if (node.type !== "activity") return KIND[node.type];
	const name = props.definition.instances[node.activity]?.descriptor.name;
	return name ? `Activity ${node.activity} · ${name}` : `Activity ${node.activity}`;
}

const replaceNode = (props: GraphProps, id: string, node: ControlNode) =>
	props.onChange({
		...props.definition,
		control: { ...props.definition.control, nodes: { ...props.definition.control.nodes, [id]: node } },
	});

/** The steps of the workflow as a list; the open one is edited in the inspector. */
export function NeutralGraphEditor(props: GraphProps & { selected: string; onSelect: (id: string) => void }) {
	function add(value: string) {
		const kind = ADDABLE.find((entry) => entry.value === value);
		if (!kind) return;
		const id = crypto.randomUUID();
		replaceNode(props, id, kind.node());
		props.onSelect(id);
	}
	return (
		<section class={s.canvas} aria-label="Workflow steps">
			<div class={s.columnHeader}>
				<h4>Steps</h4>
				{/* One menu instead of six buttons; it always reads "Add step". */}
				<Select
					class={s.addStep}
					aria-label="Add step"
					value=""
					onChange={(event) => {
						add(event.currentTarget.value);
						event.currentTarget.value = "";
					}}
				>
					<option value="">Add step</option>
					<For each={ADDABLE}>{(kind) => <option value={kind.value}>{kind.label}</option>}</For>
				</Select>
			</div>
			<nav class={s.rows} aria-label="Steps">
				{/* By id, so a row keeps its element (and focus) while its step is edited. */}
				<For each={Object.keys(props.definition.control.nodes)}>
					{(id) => (
						<button
							type="button"
							data-control-layout="row"
							class={s.row}
							aria-current={props.selected === id ? "true" : undefined}
							onClick={() => props.onSelect(id)}
						>
							<span class={s.rowName}>{props.labels[id] || id}</span>
							<small class={s.rowMeta}>{stepKind(props, props.definition.control.nodes[id])}</small>
						</button>
					)}
				</For>
			</nav>
		</section>
	);
}

/** The open step: its name and kind, what the caller adds about it (an activity's
 *  configuration), its own settings, then where each of its outcomes leads. */
export function StepFields(props: GraphProps & { id: string; children?: JSX.Element }) {
	const node = () => props.definition.control.nodes[props.id];
	const connect = (port: string, target: string) => {
		const { [port]: _removed, ...remaining } = props.definition.control.edges[props.id] ?? {};
		props.onChange({
			...props.definition,
			control: {
				...props.definition.control,
				edges: {
					...props.definition.control.edges,
					[props.id]: target ? { ...remaining, [port]: target } : remaining,
				},
			},
		});
	};
	// Ports for neutral controls are part of ControlGraph's published contract;
	// activity ports always come from the pinned catalog descriptor.
	const ports = (current: ControlNode): string[] => {
		switch (current.type) {
			case "start":
			case "wait":
				return ["next"];
			case "end":
				return [];
			case "condition":
				return ["true", "false", "unknown"];
			case "collection":
			case "fork":
				return ["complete", "blocked"];
			case "loop":
				return ["complete", "exhausted", "unknown", "failed"];
			case "activity":
				return descriptorOf(props, current)?.outcomes ?? [];
		}
	};
	return (
		<Show when={node()}>
			{(current) => (
				<section class={s.block} aria-label="Step settings">
					<header class={s.blockTitle}>
						<h4>{props.labels[props.id] || props.id}</h4>
						<p class={s.muted}>{stepKind(props, current())}</p>
					</header>
					{props.children}
					<Show when={current().type === "wait"}>
						<label class={s.field}>
							Wait (milliseconds)
							<Input
								aria-label="Wait milliseconds"
								type="number"
								min="1"
								value={(() => {
									const value = current();
									return value.type === "wait" ? value.duration_ms : 1;
								})()}
								onInput={(event) =>
									replaceNode(props, props.id, { type: "wait", duration_ms: Number(event.currentTarget.value) })
								}
							/>
						</label>
					</Show>
					<Show when={"condition" in current()}>
						<label class={s.field}>
							Condition key
							<Input
								aria-label="Condition key"
								value={(() => {
									const value = current();
									return "condition" in value ? value.condition : "";
								})()}
								onInput={(event) => {
									const value = current();
									if ("condition" in value)
										replaceNode(props, props.id, { ...value, condition: event.currentTarget.value });
								}}
							/>
						</label>
					</Show>
					<Show when={"scope" in current()}>
						<label class={s.field}>
							Scope key
							<Input
								aria-label="Scope key"
								value={(() => {
									const value = current();
									return "scope" in value ? value.scope : "";
								})()}
								onInput={(event) => {
									const value = current();
									if ("scope" in value) replaceNode(props, props.id, { ...value, scope: event.currentTarget.value });
								}}
							/>
						</label>
					</Show>
					<Show when={current().type === "end"}>
						<label class={s.field}>
							Outcome
							<Input
								aria-label="End outcome"
								value={(() => {
									const value = current();
									return value.type === "end" ? value.outcome : "";
								})()}
								onInput={(event) => replaceNode(props, props.id, { type: "end", outcome: event.currentTarget.value })}
							/>
						</label>
					</Show>
					<Show when={ports(current()).length}>
						<h5 class={s.label}>Then</h5>
						<div class={s.ports}>
							<For each={ports(current())}>
								{(port) => (
									<label class={s.port}>
										<span class={s.portName}>{port}</span>
										<Select
											aria-label={`${props.id} ${port} target`}
											value={props.definition.control.edges[props.id]?.[port] ?? ""}
											onChange={(event) => connect(port, event.currentTarget.value)}
										>
											<option value="">Not connected</option>
											<For each={Object.keys(props.definition.control.nodes)}>
												{(target) => <option value={target}>{props.labels[target] || target}</option>}
											</For>
										</Select>
									</label>
								)}
							</For>
						</div>
					</Show>
				</section>
			)}
		</Show>
	);
}
