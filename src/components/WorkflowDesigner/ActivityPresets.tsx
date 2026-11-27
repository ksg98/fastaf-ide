import { createSignal } from "solid-js";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import s from "./WorkflowDesigner.module.css";

/** Save this activity's configuration under a name, or load one back. */
export function ActivityPresets(props: {
	busy: boolean;
	onSave: (id: string, revision: number) => Promise<void>;
	onLoad: (id: string, revision: number) => Promise<void>;
}) {
	const [id, setId] = createSignal("");
	const [revision, setRevision] = createSignal(1);
	return (
		<section class={s.block} aria-label="Activity presets">
			<h5 class={s.label}>Preset</h5>
			<div class={s.pair}>
				<label class={s.field}>
					Preset ID
					<Input value={id()} onInput={(event) => setId(event.currentTarget.value)} />
				</label>
				<label class={s.field}>
					Revision
					<Input
						aria-label="Preset revision"
						type="number"
						min="1"
						value={revision()}
						onInput={(event) => setRevision(Number(event.currentTarget.value))}
					/>
				</label>
			</div>
			<div class={s.buttons}>
				<Button disabled={props.busy || !id()} onClick={() => void props.onSave(id(), revision())}>
					Save preset
				</Button>
				<Button disabled={props.busy || !id()} onClick={() => void props.onLoad(id(), revision())}>
					Load preset
				</Button>
			</div>
		</section>
	);
}
