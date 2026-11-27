import { Textarea } from "../ui/Textarea";
import type { NeutralDefinition } from "./neutralClient";
import s from "./WorkflowDesigner.module.css";

/** The whole draft as JSON: inputs, outputs, conditions, scopes and subflows. */
export function DefinitionJson(props: {
	definition: NeutralDefinition;
	onApply: (value: unknown) => Promise<void>;
	onError: (error: string) => void;
}) {
	return (
		<section class={s.block} aria-label="Definition">
			<div>
				<h4 class={s.heading}>Definition</h4>
				<p class={s.muted}>
					The whole draft as JSON, with its inputs, outputs, conditions, scopes and subflows. An edit is checked before
					it replaces the draft.
				</p>
			</div>
			<Textarea
				class={`${s.codeInput} ${s.codeTall}`}
				aria-label="Definition JSON"
				spellcheck={false}
				value={JSON.stringify(props.definition, null, 2)}
				onChange={(event) => {
					try {
						void props.onApply(JSON.parse(event.currentTarget.value));
					} catch (cause) {
						props.onError(String(cause));
					}
				}}
			/>
		</section>
	);
}
