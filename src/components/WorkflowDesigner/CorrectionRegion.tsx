import { createSignal, For, Show } from "solid-js";
import { Button } from "../ui/Button";
import { Textarea } from "../ui/Textarea";
import type { JsonValue } from "./catalogTypes";
import {
	type CorrectionRegionView,
	type NeutralPublication,
	neutralClient,
	type CorrectionRegion as Region,
} from "./neutralClient";
import type { useNeutralDraft } from "./useNeutralDraft";
import s from "./WorkflowDesigner.module.css";

/** Backend lowering owns the generated graph and its correction budget. */
export function CorrectionRegionEditor(props: { state: ReturnType<typeof useNeutralDraft> }) {
	const [source, setSource] = createSignal("");
	const [view, setView] = createSignal<CorrectionRegionView>();
	const [child, setChild] = createSignal<NeutralPublication>();
	return (
		<section class={s.block} aria-label="Correction region">
			<div>
				<h4 class={s.heading}>Correction region</h4>
				<p class={s.muted}>
					Wrap one activity in a review-and-fix loop with a fixed number of tries. Paste the region as JSON to see the
					definition it generates.
				</p>
			</div>
			<label class={s.field}>
				Correction region (JSON)
				<Textarea
					class={s.codeInput}
					value={source()}
					disabled={props.state.busy()}
					onInput={(event) => {
						setSource(event.currentTarget.value);
						setView(undefined);
						setChild(undefined);
					}}
				/>
			</label>
			<div class={s.buttons}>
				<Button
					disabled={props.state.busy() || !source().trim()}
					onClick={() =>
						void props.state.perform(async () => {
							const region = JSON.parse(source()) as Region;
							setView(await props.state.call({ action: "correction_region", region }, "correction_region"));
						})
					}
				>
					Inspect correction region
				</Button>
			</div>
			<Show when={view()}>
				{(result) => (
					<section class={s.block} aria-label="Correction region contract">
						<h5 class={s.label}>Criteria</h5>
						<ul class={s.plainList}>
							<For each={result().region.criteria.criteria}>{(criterion) => <li>{criterion}</li>}</For>
						</ul>
						<p class={s.muted}>Maximum corrections: {result().region.max_corrections}</p>
						<h5 class={s.label}>Selected activity</h5>
						<pre class={s.code}>{JSON.stringify(result().region.selected, null, 2)}</pre>
						<h5 class={s.label}>Generated definition</h5>
						<pre class={s.code}>{JSON.stringify(result().definition, null, 2)}</pre>
						<For each={result().definition.subflows}>
							{(reference) => (
								<Button
									disabled={props.state.busy()}
									onClick={() =>
										void props.state.perform(async () => {
											const call = neutralClient(() => reference.project);
											setChild(
												await call(
													{ action: "get_publication", id: reference.id, revision: reference.revision },
													"publication",
												),
											);
										})
									}
								>
									Inspect selected child {reference.id} · revision {reference.revision}
								</Button>
							)}
						</For>
						<Button
							variant="primary"
							disabled={props.state.busy()}
							onClick={() =>
								void props.state.perform(async () => {
									const definition = result().definition;
									const checked = await props.state.call({ action: "validate", definition }, "validation");
									if (!checked.valid) {
										props.state.setError(checked.diagnostics.map((item) => `${item.path}: ${item.message}`).join("\n"));
										return;
									}
									props.state.edit(definition);
								})
							}
						>
							Use the generated definition
						</Button>
					</section>
				)}
			</Show>
			<Show when={child()}>
				{(publication) => (
					<section class={s.block} aria-label="Selected correction child publication">
						<h5 class={s.label}>
							{publication().id} · revision {publication().revision} · read only
						</h5>
						<pre class={s.code}>{JSON.stringify(publication(), null, 2)}</pre>
					</section>
				)}
			</Show>
		</section>
	);
}

function record(value: JsonValue | undefined): { [key: string]: JsonValue } | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined;
}

/** Presentation of retained scope data, never a separate correction counter. */
export function RetainedCorrections(props: { scope: JsonValue | undefined }) {
	const identity = () => record(record(props.scope)?.identity);
	const kind = () => record(record(props.scope)?.kind);
	const iteration = () => kind()?.iteration;
	return (
		<Show
			when={
				identity()?.scope === "correction" &&
				kind()?.type === "loop" &&
				typeof iteration() === "number" &&
				Number.isInteger(iteration()) &&
				Number(iteration()) >= 1
			}
		>
			<section class={s.note} aria-label="Retained correction budget">
				<p>Consumed corrections: {Number(iteration()) - 1}</p>
				<p>Correction scope generation: {String(identity()?.generation)}</p>
			</section>
		</Show>
	);
}
