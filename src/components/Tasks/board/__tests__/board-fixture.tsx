import { createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import { createInMemoryWorkItemProvider } from "../../../../plugins/testing/inMemoryWorkItemProvider";
import type { WorkItemBoardPage, WorkItemQuery } from "../../../../types/work-items.gen";
import { TasksBoard } from "../TasksBoard";
import "../../../../global.css";

const provider = createInMemoryWorkItemProvider();
const query: WorkItemQuery = {
	filters: [],
	savedFilterId: null,
	search: "",
	sort: null,
	groupBy: null,
	cursor: null,
	limit: 50,
};
const Fixture = () => {
	const [page, setPage] = createSignal<WorkItemBoardPage>();
	const [reject, setReject] = createSignal(false);
	const refresh = async () => {
		setPage(await provider.board("priority", query));
	};
	void refresh();
	return (
		<div style={{ height: "100vh" }}>
			<label>
				<input type="checkbox" checked={reject()} onChange={(event) => setReject(event.currentTarget.checked)} />
				Reject moves
			</label>
			<div style={{ height: "calc(100vh - 32px)" }}>
				<Show when={page()}>
					{(snapshot) => (
						<TasksBoard
							scopeKey="demo/local"
							board={snapshot().board}
							lanes={snapshot().lanes}
							onMove={async (reference, action) => {
								if (reject()) throw new Error("Demo rejection");
								return provider.act(reference, action);
							}}
							onUpdated={() => {
								void refresh();
							}}
						/>
					)}
				</Show>
			</div>
		</div>
	);
};
const target = document.getElementById("board-fixture");
if (target) render(Fixture, target);
