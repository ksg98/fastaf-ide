import { render } from "solid-js/web";
import "../../../global.css";
import "./harness.css";
import { roadmapDemo } from "./demo";
import { TasksRoadmap } from "./TasksRoadmap";

const root = document.getElementById("roadmap-harness");
if (!root) throw new Error("Roadmap harness mount missing");
render(
	() => (
		<TasksRoadmap
			provider={roadmapDemo()}
			initialDate={new Date(2026, 9, 1)}
			onOpen={(reference) => {
				document.title = `Opened ${reference.accountId}/${reference.id}`;
			}}
		/>
	),
	root,
);
