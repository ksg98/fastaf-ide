import { createResource, Show } from "solid-js";
import { render } from "solid-js/web";
import "../../../global.css";
import "./harness.css";
import { allDemoRows, listDemo } from "./demo";
import { TaskRows } from "./TaskRows";
import { TasksList } from "./TasksList";
import s from "./tasksList.module.css";

const root = document.getElementById("tasks-harness");
if (!root) throw new Error("Harness mount missing");
const provider = listDemo(10_000);
function Harness() {
	if (!new URLSearchParams(location.search).has("stress"))
		return (
			<TasksList
				providers={[provider, listDemo(200, "second")]}
				onOpen={(reference) => {
					document.title = `Opened ${reference.accountId}/${reference.id}`;
				}}
			/>
		);
	const [items] = createResource(() => allDemoRows(provider));
	return (
		<section class={`${s.list} stress-list`}>
			<h1>Tasks · 10,000 provider items</h1>
			<Show when={items()} fallback={<p>Loading provider pages…</p>}>
				{(rows) => (
					<TaskRows
						items={rows()}
						groups={[]}
						loading={false}
						resetKey="stress"
						onOpen={(reference) => {
							document.title = `Opened ${reference.accountId}/${reference.id}`;
						}}
					/>
				)}
			</Show>
		</section>
	);
}
render(() => <Harness />, root);
