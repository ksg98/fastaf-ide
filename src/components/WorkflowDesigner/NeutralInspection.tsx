import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js";
import { subscribeEvents } from "../../transport";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Textarea } from "../ui/Textarea";
import { RetainedCorrections } from "./CorrectionRegion";
import type { Inspection, Preview } from "./neutralInspectionTypes";
import type { useNeutralDraft } from "./useNeutralDraft";
import s from "./WorkflowDesigner.module.css";

export function NeutralInspection(props: { state: ReturnType<typeof useNeutralDraft>; project: string }) {
	const [sample, setSample] = createSignal("{}");
	const [subject, setSubject] = createSignal("null");
	const [preview, setPreview] = createSignal<Preview>();
	const [inspection, setInspection] = createSignal<Inspection>();
	const [run, setRun] = createSignal("");
	createEffect(
		on(
			() => props.state.definition(),
			() => setPreview(undefined),
		),
	);
	let readGeneration = 0;
	async function inspect(after_sequence = 0) {
		const request = ++readGeneration;
		const id = run();
		const result = await props.state.call({ action: "inspect", run_id: id, after_sequence, limit: 500 }, "inspection");
		if (!disposed && request === readGeneration && run() === id) setInspection(result);
	}
	let disposed = false;
	let unlisten: (() => void) | undefined;
	void subscribeEvents(
		{
			"workflow-run-changed": (payload) => {
				const event = payload as { repo_path?: unknown; payload?: { runId?: unknown } } | null;
				if (event?.repo_path === props.project && event.payload?.runId === run())
					void inspect().catch((cause) => {
						if (!disposed) props.state.setError(String(cause));
					});
			},
		},
		{
			onResync: () => {
				if (run())
					void inspect().catch((cause) => {
						if (!disposed) props.state.setError(String(cause));
					});
			},
		},
	)
		.then((stop) => {
			if (disposed) stop();
			else unlisten = stop;
		})
		.catch((cause) => props.state.setError(String(cause)));
	onCleanup(() => {
		disposed = true;
		unlisten?.();
	});
	return (
		<section class={s.split} aria-label="Preview and retained run inspection">
			<div class={s.block}>
				<div>
					<h4 class={s.heading}>Preview</h4>
					<p class={s.muted}>
						Nothing runs. The draft's inputs are resolved from the samples and each effect is only described.
					</p>
				</div>
				<label class={s.field}>
					Sample inputs (JSON)
					<Textarea
						class={s.codeInput}
						value={sample()}
						onInput={(event) => {
							setSample(event.currentTarget.value);
							setPreview(undefined);
						}}
					/>
				</label>
				<label class={s.field}>
					Sample subject (JSON or null)
					<Textarea
						class={s.codeInput}
						value={subject()}
						onInput={(event) => {
							setSubject(event.currentTarget.value);
							setPreview(undefined);
						}}
					/>
				</label>
				<div class={s.buttons}>
					<Button
						onClick={() =>
							void props.state.perform(async () => {
								setPreview(
									await props.state.call(
										{
											action: "preview",
											definition: props.state.definition(),
											inputs: JSON.parse(sample()),
											subject: JSON.parse(subject()),
										},
										"preview",
									),
								);
							})
						}
					>
						Run preview
					</Button>
				</div>
				<Show when={preview()}>
					{(result) => (
						<section class={s.block} aria-label="Resolved preview">
							<For each={result().validation.diagnostics}>
								{(item) => (
									<p class={s.fieldError}>
										{item.path} · {item.message}
									</p>
								)}
							</For>
							<For each={result().activities}>
								{(activity) => (
									<details class={s.disclosure} open>
										<summary>Activity {activity.activity}</summary>
										<h5 class={s.label}>Inputs</h5>
										<pre class={s.code}>{JSON.stringify(activity.inputs, null, 2)}</pre>
										<Show when={activity.unavailable_reason}>
											<p class={s.note}>{activity.unavailable_reason}</p>
										</Show>
										<h5 class={s.label}>Effect it would prepare</h5>
										<pre class={s.code}>{JSON.stringify(activity.effect_intent, null, 2)}</pre>
										<h5 class={s.label}>Outputs · {activity.outcomes.join(", ")}</h5>
										<pre class={s.code}>{JSON.stringify(activity.outputs, null, 2)}</pre>
									</details>
								)}
							</For>
						</section>
					)}
				</Show>
			</div>
			<div class={s.block}>
				<div>
					<h4 class={s.heading}>Inspect a run</h4>
					<p class={s.muted}>Read a run's saved state by its ID. Reading never resumes or changes it.</p>
				</div>
				<label class={s.field}>
					Run ID
					<Input
						value={run()}
						onInput={(event) => {
							setRun(event.currentTarget.value);
							setInspection(undefined);
						}}
					/>
				</label>
				<div class={s.buttons}>
					<Button disabled={!run()} onClick={() => void props.state.perform(() => inspect())}>
						Inspect run
					</Button>
				</div>
				<Show when={inspection()}>
					{(result) => (
						<section class={s.block} aria-label="Retained run">
							<h5 class={s.label}>Current step and status</h5>
							<pre class={s.code}>
								{JSON.stringify(
									{
										node: result().snapshot.node,
										execution: result().snapshot.execution,
										status: result().snapshot.status,
									},
									null,
									2,
								)}
							</pre>
							<h5 class={s.label}>Outputs</h5>
							<pre class={s.code}>
								{JSON.stringify(
									{ outputs: result().snapshot.outputs, activity_outputs: result().snapshot.activity_outputs },
									null,
									2,
								)}
							</pre>
							<h5 class={s.label}>Waits and scope</h5>
							<pre class={s.code}>
								{JSON.stringify(
									{
										wait_due_ms: result().snapshot.wait_due_ms,
										active_scope: result().snapshot.active_scope,
										parent: result().snapshot.parent,
										parent_fence: result().snapshot.parent_fence,
									},
									null,
									2,
								)}
							</pre>
							<RetainedCorrections scope={result().snapshot.active_scope} />
							<h5 class={s.label}>Effects</h5>
							<pre class={s.code}>{JSON.stringify(result().snapshot.effects, null, 2)}</pre>
							<h5 class={s.label}>Events</h5>
							<pre class={s.code}>{JSON.stringify(result().events, null, 2)}</pre>
							<div class={s.buttons}>
								<Button
									disabled={result().events.length < 500}
									onClick={() => void props.state.perform(() => inspect(result().events.at(-1)?.sequence ?? 0))}
								>
									Next page of events
								</Button>
							</div>
						</section>
					)}
				</Show>
			</div>
		</section>
	);
}
