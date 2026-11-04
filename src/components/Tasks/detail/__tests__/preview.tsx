/** Developer fixture: real core component + A4 synthetic provider, no live account. */
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import "../../../../global.css";
import "../../../../styles.css";
import { createInMemoryWorkItemProvider } from "../../../../plugins/testing/inMemoryWorkItemProvider";
import { workItemsDemo } from "../../../../plugins/testing/work-items-demo.gen";
import type { WorkItemProvider } from "../../../../plugins/workItemProvider";
import type { WorkItemProviderSnapshot } from "../../../../types/work-items.gen";
import { TasksDetail } from "../TasksDetail";
import recordedComment from "./fixtures/coderabbit-comment.md?raw";
import "./preview.css";

const seed: WorkItemProviderSnapshot = structuredClone(workItemsDemo);
const first = seed.items[0];
first.item.title = "Preserve terminal history while an agent writes";
first.body =
	"## Expected behavior\n\nKeep the reader at their chosen position while new output arrives.\n\n- Preserve the visible history\n- Keep keyboard navigation available\n\n| Surface | Status |\n| --- | --- |\n| Desktop | Ready for review |\n| Mobile | Ready for review |";
first.actions.push({ id: "edit", name: "Edit fields", kind: "edit_field", enabled: true, disabledReason: null });
first.comments.entries.unshift({
	kind: "normal",
	value: {
		id: "recorded-bot",
		author: { id: "bot", name: "CodeRabbit", avatarUrl: null, bot: true },
		body: recordedComment,
		createdAt: "2026-10-10T12:00:00Z",
		url: null,
	},
});
const source = createInMemoryWorkItemProvider(seed);

function Preview() {
	const [reject, setReject] = createSignal(false);
	const [visible, setVisible] = createSignal(true);
	const provider: WorkItemProvider = {
		...source,
		act: async (reference, action, signal) => {
			if (reject() && action.kind === "transition")
				throw new Error("HTTP 422: transition rejected by the fixture provider");
			return source.act(reference, action, signal);
		},
	};
	return (
		<>
			<div class="fixture-controls">
				<label>
					<input type="checkbox" checked={reject()} onChange={(event) => setReject(event.currentTarget.checked)} />
					Reject status changes
				</label>
				<button type="button" onClick={() => setVisible(!visible())}>
					{visible() ? "Hide detail" : "Show detail"}
				</button>
			</div>
			<div class="fixture-detail">
				<TasksDetail provider={provider} reference={first.item.reference} visible={visible()} />
			</div>
		</>
	);
}
const root = document.getElementById("root");
if (!root) throw new Error("Missing fixture root");
render(() => <Preview />, root);
