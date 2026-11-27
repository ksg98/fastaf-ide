import { createSignal, createUniqueId, For, Show } from "solid-js";
import { IconPlus, IconRefresh } from "../icons";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { Switch } from "../ui/Switch";
import { Textarea } from "../ui/Textarea";
import type { NeutralPublication } from "./neutralClient";
import { TriggerMappings } from "./TriggerMappings";
import type { TriggerBindingDraft } from "./triggerTypes";
import { useTriggerBinding } from "./useTriggerBinding";
import s from "./WorkflowDesigner.module.css";

export function TriggerBindings(props: { project: string; publications: NeutralPublication[] }) {
	const state = useTriggerBinding(
		() => props.project,
		() => props.publications,
	);
	const [options, setOptions] = createSignal("");
	const [optionsError, setOptionsError] = createSignal("");
	return (
		<section class={s.triggers} aria-label="Trigger bindings">
			{/* Saved bindings on the left, the open one on the right: the dialog's list | detail shape. */}
			<aside class={s.sidebar} aria-label="Saved bindings">
				<div class={s.columnHeader}>
					<h4>Bindings</h4>
					<div class={s.headerButtons}>
						<button
							type="button"
							class={s.iconBtn}
							aria-label="Refresh bindings"
							title="Refresh bindings"
							disabled={state.busy()}
							onClick={() => void state.perform(state.refresh)}
						>
							<IconRefresh size={16} />
						</button>
						<button
							type="button"
							class={s.iconBtn}
							aria-label="New binding"
							title="New binding"
							disabled={state.busy()}
							onClick={state.newBinding}
						>
							<IconPlus size={16} />
						</button>
					</div>
				</div>
				<div class={s.rows}>
					<For
						each={state.bindings()}
						fallback={<p class={s.empty}>No bindings yet. Fill in the form and save to add one.</p>}
					>
						{(binding) => {
							const reasonId = createUniqueId();
							return (
								<div class={s.binding}>
									<button
										type="button"
										data-control-layout="row"
										class={s.row}
										disabled={state.busy()}
										aria-current={state.revision() > 0 && state.draft().id === binding.draft.id ? "true" : undefined}
										aria-label={`Load ${binding.draft.id} · revision ${binding.revision} · ${binding.enabled ? "enabled" : "disabled"}`}
										aria-describedby={binding.refusal_reason ? reasonId : undefined}
										title="Open this binding. Unsaved edits are replaced."
										onClick={() => state.choose(binding)}
									>
										<span
											class={s.stateDot}
											data-state={binding.refusal_reason ? "held" : binding.enabled ? "on" : "off"}
											aria-hidden="true"
										/>
										<span class={s.rowName}>{binding.draft.id}</span>
										<small class={s.rowMeta}>rev {binding.revision}</small>
									</button>
									<Show when={binding.refusal_reason}>
										{(reason) => (
											<span id={reasonId} class={s.refusal}>
												No intake: {reason()}
											</span>
										)}
									</Show>
								</div>
							);
						}}
					</For>
				</div>
			</aside>
			<fieldset disabled={state.busy()} class={s.triggerForm}>
				<div class={s.triggerScroll}>
					<Show when={state.error()}>
						<p class={s.error} role="alert">
							{state.error()}
						</p>
					</Show>
					<p class={s.muted}>
						A binding starts a published workflow when a matching event arrives. Preview the mapping before you enable
						it.
					</p>
					<div class={s.columns}>
						<div class={s.block}>
							<label class={s.field}>
								Binding ID
								<Input
									value={state.draft().id}
									disabled={state.revision() > 0}
									onInput={(e) => state.edit({ ...state.draft(), id: e.currentTarget.value })}
								/>
							</label>
							<label class={s.field}>
								Published workflow
								<Select
									value={`${state.draft().publication.id}@${state.draft().publication.revision}`}
									onChange={(e) => {
										const value = props.publications.find(
											(item) => `${item.id}@${item.revision}` === e.currentTarget.value,
										);
										if (value)
											state.edit({
												...state.draft(),
												publication: { project: value.project, id: value.id, revision: value.revision },
												mapping: { inputs: {}, subject: {} },
											});
									}}
								>
									<option value="@0">Choose a published workflow</option>
									<For each={props.publications}>
										{(item) => (
											<option value={`${item.id}@${item.revision}`}>
												{item.id} · revision {item.revision}
											</option>
										)}
									</For>
								</Select>
							</label>
							<div class={s.pair}>
								<label class={s.field}>
									Source
									<Select aria-label="Trigger source" value={state.draft().source} disabled>
										<option value="github">GitHub</option>
									</Select>
								</label>
								<label class={s.field}>
									Resource
									<Select
										aria-label="Resource kind"
										value={state.draft().kind}
										onChange={(e) =>
											state.edit({
												...state.draft(),
												kind: e.currentTarget.value,
												mapping: { inputs: {}, subject: {} },
											})
										}
									>
										<option value="issue">Issue</option>
										<option value="pull_request">Pull request</option>
									</Select>
								</label>
							</div>
							<label class={s.field}>
								Resource prefix
								<Input
									placeholder="github:owner/repository/issue/"
									value={state.draft().resource_prefix}
									onInput={(e) => state.edit({ ...state.draft(), resource_prefix: e.currentTarget.value })}
								/>
							</label>
							<label class={s.field}>
								Events (comma separated)
								<Input
									value={state.draft().events.join(", ")}
									onChange={(e) =>
										state.edit({
											...state.draft(),
											events: e.currentTarget.value
												.split(",")
												.map((v) => v.trim())
												.filter(Boolean),
										})
									}
								/>
							</label>
							<details class={s.disclosure}>
								<summary>Filters and run limits</summary>
								<p class={s.muted}>
									A JSON object with filters, ignored_actors and limits. It is checked on preview and on save.
								</p>
								<Textarea
									class={s.codeInput}
									aria-label="Trigger options JSON"
									value={options()}
									placeholder={JSON.stringify(
										{
											filters: state.draft().filters,
											ignored_actors: state.draft().ignored_actors,
											limits: state.draft().limits,
										},
										null,
										2,
									)}
									onInput={(e) => setOptions(e.currentTarget.value)}
								/>
								<div class={s.buttons}>
									<Button
										onClick={() => {
											try {
												const value = JSON.parse(options()) as Pick<
													TriggerBindingDraft,
													"filters" | "ignored_actors" | "limits"
												>;
												state.edit({
													...state.draft(),
													filters: value.filters,
													ignored_actors: value.ignored_actors,
													limits: value.limits,
												});
												setOptionsError("");
											} catch {
												setOptionsError("Enter a JSON object with filters, ignored_actors and limits.");
											}
										}}
									>
										Apply options
									</Button>
								</div>
								<Show when={optionsError()}>
									<p role="alert" class={s.fieldError}>
										{optionsError()}
									</p>
								</Show>
							</details>
						</div>
						<div class={s.block}>
							<Show
								when={state.publication()}
								fallback={<p class={s.muted}>Choose a published workflow to map its inputs.</p>}
							>
								{(publication) => (
									<>
										<TriggerMappings
											title="Workflow inputs"
											source={state.schema()}
											target={publication().definition.inputs}
											mapping={state.draft().mapping.inputs}
											onChange={(inputs) =>
												state.edit({ ...state.draft(), mapping: { ...state.draft().mapping, inputs } })
											}
										/>
										<Show when={publication().definition.subject}>
											{(subject) => (
												<TriggerMappings
													title="Workflow subject"
													source={state.schema()}
													target={subject().fields}
													mapping={state.draft().mapping.subject}
													onChange={(value) =>
														state.edit({ ...state.draft(), mapping: { ...state.draft().mapping, subject: value } })
													}
												/>
											)}
										</Show>
									</>
								)}
							</Show>
							<label class={s.field}>
								Normalized event snapshot
								<Textarea
									class={s.codeInput}
									value={state.sample()}
									onInput={(e) => state.setSample(e.currentTarget.value)}
									placeholder="Paste one event as JSON to preview the mapping"
								/>
							</label>
							<div class={s.buttons}>
								<Button disabled={!state.publication() || !state.sample()} onClick={() => void state.previewMapping()}>
									Preview trigger mapping
								</Button>
							</div>
							<Show when={state.preview()}>
								{(preview) => (
									<section class={s.block} aria-label="Trigger mapping preview">
										<h5 class={s.label}>Mapped payload</h5>
										<pre class={s.code}>
											{JSON.stringify({ inputs: preview().inputs, subject: preview().subject }, null, 2)}
										</pre>
										<h5 class={s.label}>Enabled bindings that overlap</h5>
										<For each={Object.entries(preview().overlaps)} fallback={<p class={s.muted}>None.</p>}>
											{([id, revision]) => (
												<p class={s.overlap}>
													{id} · revision {revision}
												</p>
											)}
										</For>
										<label class={s.checkRow}>
											<Switch
												role="checkbox"
												checked={state.acknowledged()}
												onChange={(e) => state.setAcknowledged(e.currentTarget.checked)}
											/>
											Enable alongside the overlapping bindings listed above
										</label>
									</section>
								)}
							</Show>
						</div>
					</div>
				</div>
				<footer class={s.footerBar}>
					<p class={s.status}>
						Revision {state.revision()} · {state.enabled() ? "enabled" : "disabled"}
						{state.dirty() ? " · unsaved changes" : ""}
					</p>
					<div class={s.buttons}>
						<Button disabled={!state.draft().id || !state.publication()} onClick={() => void state.save()}>
							Save disabled binding
						</Button>
						<Button
							variant="primary"
							disabled={
								state.dirty() || !state.revision() || (!state.enabled() && (!state.preview() || !state.acknowledged()))
							}
							onClick={() => void state.toggle()}
						>
							{state.enabled() ? "Disable binding" : "Enable binding"}
						</Button>
					</div>
				</footer>
			</fieldset>
		</section>
	);
}
