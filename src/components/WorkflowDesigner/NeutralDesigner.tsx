import { createSignal, For, Show } from "solid-js";
import { cx } from "../../utils";
import { IconClose, IconPlus, IconRefresh } from "../icons";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { ActivityPresets } from "./ActivityPresets";
import { CatalogInspector } from "./CatalogInspector";
import { CorrectionRegionEditor } from "./CorrectionRegion";
import type { ActivityDescriptor } from "./catalogTypes";
import { DefinitionJson } from "./DefinitionJson";
import { MappingFields } from "./MappingFields";
import { NeutralGraphEditor, StepFields } from "./NeutralGraphEditor";
import { NeutralInspection } from "./NeutralInspection";
import type { NeutralPublication } from "./neutralClient";
import { TriggerBindings } from "./TriggerBindings";
import { useNeutralDraft } from "./useNeutralDraft";
import s from "./WorkflowDesigner.module.css";

type DesignerTab = "designer" | "triggers" | "preview" | "definition";

const TABS: { id: DesignerTab; label: string }[] = [
	{ id: "designer", label: "Designer" },
	{ id: "triggers", label: "Triggers" },
	{ id: "preview", label: "Preview" },
	{ id: "definition", label: "Definition" },
];

/** The workflow designer: drafts and the activity catalog, the steps, the open step. */
export function NeutralDesigner(props: { project: string }) {
	const state = useNeutralDraft(() => props.project);
	const [selected, setSelected] = createSignal("start");
	const [pin, setPin] = createSignal<NeutralPublication>();
	const [tab, setTab] = createSignal<DesignerTab>("designer");
	// Trigger bindings load on first use, then keep their unsaved edits across tabs.
	const [triggersOpened, setTriggersOpened] = createSignal(false);
	const openTab = (next: DesignerTab) => {
		if (next === "triggers") setTriggersOpened(true);
		setTab(next);
	};
	const tabKeys = (event: KeyboardEvent) => {
		const at = TABS.findIndex((entry) => entry.id === tab());
		const next =
			event.key === "ArrowRight"
				? (at + 1) % TABS.length
				: event.key === "ArrowLeft"
					? (at - 1 + TABS.length) % TABS.length
					: event.key === "Home"
						? 0
						: event.key === "End"
							? TABS.length - 1
							: -1;
		if (next < 0) return;
		event.preventDefault();
		openTab(TABS[next].id);
		(event.currentTarget as HTMLElement).querySelector<HTMLButtonElement>(`[data-tab="${TABS[next].id}"]`)?.focus();
	};
	/** Where the open draft stands, in a few words beside its actions. */
	const draftStatus = () => {
		const current = state.draft();
		const saved = current
			? current.latest_published_revision > 0
				? `Revision ${current.revision} · published ${current.latest_published_revision}`
				: `Revision ${current.revision} · not published`
			: "Not saved yet";
		return state.dirty() ? `${saved} · unsaved changes` : saved;
	};
	const node = () => state.definition().control.nodes[selected()];
	const ordinal = () => {
		const current = node();
		return current?.type === "activity" ? current.activity : undefined;
	};
	const instance = () => {
		const index = ordinal();
		return index === undefined ? undefined : state.definition().instances[index];
	};
	const descriptor = () => {
		const id = instance()?.descriptor;
		return state
			.catalog()
			.activities.find(
				(item) => item.id.namespace === id?.namespace && item.id.name === id?.name && item.id.version === id?.version,
			);
	};
	function add(descriptor: ActivityDescriptor) {
		const definition = state.definition();
		const id = crypto.randomUUID();
		state.edit({
			...definition,
			instances: [...definition.instances, { descriptor: descriptor.id, config: {}, execution_policy: "" }],
			control: {
				...definition.control,
				nodes: { ...definition.control.nodes, [id]: { type: "activity", activity: definition.instances.length } },
			},
		});
		setSelected(id);
	}

	return (
		<section class={s.designer} aria-label="Workflow designer">
			{/* One bar under the dialog header: the views where a panel puts its title,
			    then the open draft's state and its actions. */}
			<div class={s.bar}>
				<div class={s.tabs} role="tablist" aria-label="Workflow views" onKeyDown={tabKeys}>
					<For each={TABS}>
						{(entry) => (
							<button
								type="button"
								role="tab"
								class={s.tab}
								data-tab={entry.id}
								aria-selected={tab() === entry.id}
								tabIndex={tab() === entry.id ? 0 : -1}
								onClick={() => openTab(entry.id)}
							>
								{entry.label}
							</button>
						)}
					</For>
				</div>
				{/* The draft's state and actions; trigger bindings have their own. */}
				<div class={cx(s.toolbar, tab() === "triggers" && s.hidden)}>
					<span class={s.status}>{draftStatus()}</span>
					<button
						type="button"
						class={s.iconBtn}
						aria-label="Refresh catalog"
						title="Refresh drafts and the activity catalog"
						disabled={state.busy()}
						onClick={() => void state.perform(state.refresh)}
					>
						<IconRefresh size={16} />
					</button>
					<Button
						disabled={state.busy()}
						title="Check the draft's links and inputs"
						onClick={() =>
							void state.perform(async () => {
								await state.validate();
							})
						}
					>
						Validate
					</Button>
					<Button disabled={state.busy()} onClick={() => void state.perform(state.save)}>
						Save draft
					</Button>
					<Button
						variant="primary"
						disabled={state.busy() || state.dirty() || !state.draft()}
						title={state.dirty() || !state.draft() ? "Save the draft before publishing" : undefined}
						onClick={() => void state.perform(state.publish)}
					>
						Publish
					</Button>
				</div>
			</div>
			<Show when={state.error() || state.catalogError() || state.diagnostics().length}>
				<div class={s.banner}>
					<Show when={state.error() || state.catalogError()}>
						<p class={s.error} role="alert">
							{state.error() || state.catalogError()}
						</p>
					</Show>
					<For each={state.diagnostics()}>
						{(item) => (
							<p class={s.error}>
								{item.path} · {item.message}
							</p>
						)}
					</For>
				</div>
			</Show>
			<fieldset disabled={state.busy()} class={cx(s.body, tab() !== "designer" && s.hidden)}>
				<aside class={s.sidebar} aria-label="Drafts and catalog">
					<label class={s.field}>
						Workflow name
						<Input
							value={state.name()}
							onInput={(event) => {
								state.setName(event.currentTarget.value);
								state.setDirty(true);
							}}
						/>
					</label>
					<div class={s.sectionHead}>
						<h4>Drafts</h4>
						<button
							type="button"
							class={s.iconBtn}
							aria-label="New blank draft"
							title={state.dirty() ? "Save the current draft first" : "New blank draft"}
							disabled={state.dirty()}
							onClick={state.newDraft}
						>
							<IconPlus size={16} />
						</button>
					</div>
					<div class={s.rows}>
						<For each={state.drafts()} fallback={<p class={s.empty}>No saved drafts.</p>}>
							{(draft) => (
								<button
									type="button"
									data-control-layout="row"
									class={s.row}
									aria-label={`${draft.name} · revision ${draft.revision}`}
									aria-current={state.draft()?.id === draft.id ? "true" : undefined}
									onClick={() => {
										state.choose(draft);
										setSelected("start");
									}}
								>
									<span class={s.rowName}>{draft.name}</span>
									<small class={s.rowMeta}>rev {draft.revision}</small>
								</button>
							)}
						</For>
					</div>
					<Show when={state.templates().length}>
						<div class={s.sectionHead}>
							<h4>Templates</h4>
						</div>
						<div class={s.rows}>
							<For each={state.templates()}>
								{(template) => (
									<button
										type="button"
										data-control-layout="row"
										class={s.row}
										disabled={state.dirty()}
										aria-label={`New from template: ${template.name}`}
										title={template.description}
										onClick={() => {
											state.fromTemplate(template);
											setSelected("start");
										}}
									>
										<IconPlus size={14} class={s.rowIcon} />
										<span class={s.rowName}>{template.name}</span>
									</button>
								)}
							</For>
						</div>
					</Show>
					<div class={s.sectionHead}>
						<h4>Activities</h4>
					</div>
					<div class={s.rows}>
						<For
							each={state.catalog().activities}
							fallback={<p class={s.empty}>No activities loaded. Refresh once the workflow engine is available.</p>}
						>
							{(item) => (
								<button
									type="button"
									data-control-layout="row"
									class={s.row}
									aria-label={`Add ${item.id.name} · v${item.id.version}`}
									title={item.purpose}
									onClick={() => add(item)}
								>
									<IconPlus size={14} class={s.rowIcon} />
									<span class={s.rowName}>{item.id.name}</span>
									<small class={s.rowMeta}>v{item.id.version}</small>
								</button>
							)}
						</For>
					</div>
					<Show when={state.catalog().metanodes.length}>
						<div class={s.sectionHead}>
							<h4>Published</h4>
						</div>
						<div class={s.rows}>
							<For each={state.catalog().metanodes}>
								{(item) => (
									<button
										type="button"
										data-control-layout="row"
										class={s.row}
										aria-label={`Inspect ${item.id} · revision ${item.revision}`}
										aria-current={pin()?.id === item.id && pin()?.revision === item.revision ? "true" : undefined}
										title="Read only. Open it to customize it in a new draft."
										onClick={() =>
											void state.perform(async () => {
												setPin(
													await state.call(
														{ action: "get_publication", id: item.id, revision: item.revision },
														"publication",
													),
												);
											})
										}
									>
										<span class={s.rowName}>{item.id}</span>
										<small class={s.rowMeta}>rev {item.revision}</small>
									</button>
								)}
							</For>
						</div>
					</Show>
				</aside>
				<Show
					when={pin()}
					fallback={
						<NeutralGraphEditor
							definition={state.definition()}
							activities={state.catalog().activities}
							labels={state.editor().labels}
							selected={selected()}
							onSelect={setSelected}
							onChange={state.edit}
						/>
					}
				>
					{(publication) => (
						<section class={s.canvas} aria-label="Pinned metanode graph">
							<div class={s.columnHeader}>
								<h4>
									{publication().id} · revision {publication().revision} · read only
								</h4>
								<div class={s.headerButtons}>
									<Button
										disabled={state.busy() || state.dirty()}
										title={state.dirty() ? "Save the current draft first" : undefined}
										onClick={() =>
											void state.perform(async () => {
												const draft = await state.call(
													{
														action: "clone_publication",
														id: publication().id,
														revision: publication().revision,
														name: `${publication().id} draft`,
													},
													"draft",
												);
												state.choose(draft);
												setPin(undefined);
												await state.refresh();
											})
										}
									>
										Customize in a new draft
									</Button>
									<button
										type="button"
										class={s.iconBtn}
										aria-label="Back to the draft"
										title="Back to the draft"
										onClick={() => setPin(undefined)}
									>
										<IconClose size={16} />
									</button>
								</div>
							</div>
							<pre class={s.code}>{JSON.stringify(publication().definition, null, 2)}</pre>
						</section>
					)}
				</Show>
				<aside class={s.inspector} aria-label="Step inspector">
					<StepFields
						definition={state.definition()}
						activities={state.catalog().activities}
						labels={state.editor().labels}
						id={selected()}
						onChange={state.edit}
					>
						<Show when={descriptor()}>
							{(entry) => (
								<Show when={instance()}>
									{(current) => (
										<>
											<CatalogInspector
												descriptor={entry()}
												instance={current()}
												label={state.editor().labels[selected()] ?? ""}
												onLabel={(label) =>
													state.editEditor({
														...state.editor(),
														labels: { ...state.editor().labels, [selected()]: label },
													})
												}
												onChange={(next) => {
													const index = ordinal();
													if (index === undefined) return;
													state.edit({
														...state.definition(),
														instances: state.definition().instances.map((value, i) => (i === index ? next : value)),
													});
												}}
											/>

											<MappingFields
												schema={entry().inputs}
												bindings={state.definition().input_bindings[String(ordinal())] ?? {}}
												onChange={(bindings) =>
													state.edit({
														...state.definition(),
														input_bindings: { ...state.definition().input_bindings, [String(ordinal())]: bindings },
													})
												}
											/>
										</>
									)}
								</Show>
							)}
						</Show>
					</StepFields>
					<Show when={descriptor() ? instance() : undefined}>
						{(current) => (
							<ActivityPresets
								busy={state.busy()}
								onSave={(id, revision) =>
									state.perform(async () => {
										await state.call(
											{ action: "save_preset", id, expected_revision: revision - 1, instance: current() },
											"preset",
										);
									})
								}
								onLoad={(id, revision) =>
									state.perform(async () => {
										const saved = await state.call({ action: "get_preset", id, revision }, "preset");
										const index = ordinal();
										if (index === undefined) return;
										state.edit({
											...state.definition(),
											instances: state.definition().instances.map((value, i) => (i === index ? saved.instance : value)),
										});
									})
								}
							/>
						)}
					</Show>
				</aside>
			</fieldset>
			<div class={cx(s.pane, s.paneFlush, tab() !== "triggers" && s.hidden)}>
				<Show when={triggersOpened()}>
					<TriggerBindings project={props.project} publications={state.catalog().metanodes} />
				</Show>
			</div>
			<div class={cx(s.pane, tab() !== "preview" && s.hidden)}>
				<NeutralInspection state={state} project={props.project} />
			</div>
			<div class={cx(s.pane, tab() !== "definition" && s.hidden)}>
				<div class={s.split}>
					<DefinitionJson
						definition={state.definition()}
						onApply={(value) =>
							state.perform(async () => {
								const checked = await state.call({ action: "validate", definition: value }, "validation");
								if (!checked.valid) {
									state.setError(checked.diagnostics.map((item) => `${item.path}: ${item.message}`).join("\n"));
									return;
								}
								state.edit(value as import("./neutralClient").NeutralDefinition);
							})
						}
						onError={state.setError}
					/>
					<CorrectionRegionEditor state={state} />
				</div>
			</div>
		</section>
	);
}
