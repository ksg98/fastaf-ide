import { createSignal } from "solid-js";

const [sequences, setSequences] = createSignal<Record<string, number>>({});
const [resyncRevision, setResyncRevision] = createSignal(0);

function key(project: string, runId: string): string {
	return `${project}\0${runId}`;
}

export const workflowRunSignals = {
	sequence(project: string, runId: string): number {
		return sequences()[key(project, runId)] ?? 0;
	},
	resyncRevision,
	accept(wake: unknown): void {
		if (typeof wake !== "object" || wake === null || !("payload" in wake) || !("repo_path" in wake)) return;
		const { payload, repo_path: project } = wake;
		if (typeof payload !== "object" || payload === null || !("runId" in payload) || !("sequence" in payload)) return;
		const { runId, sequence } = payload;
		if (
			typeof project !== "string" ||
			!project ||
			typeof runId !== "string" ||
			!runId ||
			typeof sequence !== "number" ||
			!Number.isSafeInteger(sequence) ||
			sequence < 1
		)
			return;
		const runKey = key(project, runId);
		setSequences((current) => ({ ...current, [runKey]: Math.max(current[runKey] ?? 0, sequence) }));
	},
	resync(): void {
		setResyncRevision((revision) => revision + 1);
	},
};
