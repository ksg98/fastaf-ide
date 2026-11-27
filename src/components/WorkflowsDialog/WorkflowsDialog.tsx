import type { Component } from "solid-js";
import { registerModal } from "../../stores/modalStack";
import { storiesUi } from "../../stores/storiesUi";
import { workflowsUi } from "../../stores/workflowsUi";
import { IconClose } from "../icons";
import s from "../StoriesDialog/StoriesDialog.module.css";
import d from "../shared/dialog.module.css";
import { Button } from "../ui/Button";
import { WorkflowDesigner } from "../WorkflowDesigner/WorkflowDesigner";

/** Workflows space: definitions next to Plans and stories. It never needs a
 *  selected plan or story. Same frame and header as Plans and Stories. */
export const WorkflowsDialog: Component<{ project: string; onClose: () => void }> = (props) => {
	// Opens on top of Plans and Stories: Escape closes this one first.
	registerModal(props.onClose);
	return (
		<div class={d.overlay} onClick={() => props.onClose()}>
			<div
				class={s.dialog}
				role="dialog"
				aria-modal="true"
				aria-label="Workflows"
				onClick={(event) => event.stopPropagation()}
			>
				<header class={s.header}>
					<div>
						<h2>Workflows</h2>
						<span class={s.project} title={props.project}>
							{props.project}
						</span>
					</div>
					<div class={s.headerActions}>
						<Button
							variant="ghost"
							type="button"
							onClick={() => {
								storiesUi.open(props.project);
								workflowsUi.close();
							}}
						>
							Plans and stories
						</Button>
					</div>
					<div class={s.windowControls}>
						<button
							type="button"
							class={s.iconBtn}
							aria-label="Close Workflows"
							title="Close"
							onClick={() => props.onClose()}
						>
							<IconClose size={16} />
						</button>
					</div>
				</header>
				<WorkflowDesigner project={props.project} />
			</div>
		</div>
	);
};
