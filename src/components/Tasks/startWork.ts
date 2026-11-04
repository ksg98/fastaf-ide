import { createSignal } from "solid-js";
import { startWork } from "../../hooks/git/startWork";
import type { WorkItemProvider } from "../../plugins/workItemProvider";
import { rpc } from "../../transport";
import type { WorkItem, WorkItemDetail, WorkItemStartWork } from "../../types/work-items.gen";

/** Item field a provider fills with the branch it suggests; it is a hint, not a schema field. */
export const BRANCH_HINT_FIELD = "branch";
const SLUG_MAX = 60;

/** The provider's suggested branch, else a slug of key and title. */
export function suggestedBranch(item: WorkItem): string {
	const hint = item.fields[BRANCH_HINT_FIELD];
	if (hint?.kind === "text" && hint.value.trim()) return hint.value.trim();
	const slug = `${item.key} ${item.title}`
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.slice(0, SLUG_MAX)
		.replace(/^-+|-+$/g, "");
	return slug || "task";
}

export const START_WORK_NEEDS_REPO = "Open a repository to start work";

type StartWorkState =
	| { phase: "idle" }
	| { phase: "pending" }
	| { phase: "done"; branch: string }
	| { phase: "error"; message: string };

/** Asks the provider for the start-work intent, then hands it to the host. One run at a time. */
export function useStartWork() {
	const [state, setState] = createSignal<StartWorkState>({ phase: "idle" });
	const pending = () => state().phase === "pending";
	let epoch = 0;
	async function run(provider: WorkItemProvider, detail: WorkItemDetail, repoPath: string): Promise<void> {
		if (pending()) return;
		const attempt = epoch;
		const { item } = detail;
		setState({ phase: "pending" });
		try {
			const prompt = await rpc<string>("build_start_work_prompt", {
				repoPath,
				input: { key: item.key, url: item.url, title: item.title, body: detail.body },
			});
			const request: WorkItemStartWork = {
				repoPath,
				branch: suggestedBranch(item),
				baseRef: null,
				prompt,
				agentType: null,
				delivery: "draft",
			};
			const result = await provider.act(item.reference, { kind: "start_work", value: request });
			if (result.kind !== "start_work") throw new Error("The provider did not return a start-work request.");
			const started = await startWork({
				...result.value,
				link: { reference: item.reference, key: item.key, title: item.title, url: item.url, state: item.state },
			});
			if (attempt === epoch) setState({ phase: "done", branch: started.branch });
		} catch (cause) {
			if (attempt === epoch)
				setState({ phase: "error", message: cause instanceof Error ? cause.message : String(cause) });
		}
	}
	/** Forget the outcome, e.g. when another item is shown. */
	function reset() {
		epoch++;
		setState({ phase: "idle" });
	}
	const startedBranch = () => {
		const current = state();
		return current.phase === "done" ? current.branch : undefined;
	};
	const failure = () => {
		const current = state();
		return current.phase === "error" ? current.message : undefined;
	};
	return { pending, startedBranch, failure, run, reset };
}
