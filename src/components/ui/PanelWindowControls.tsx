import { type Component, Show } from "solid-js";
import { closePanel, detachPanel, reattachPanel } from "../../panelRouter";
import { isTauri } from "../../transport";
import { IconClose as SharedClose, IconExternal as SharedExternal } from "../icons";
import s from "./PanelWindowControls.module.css";

export const IconDetach = () => <SharedExternal size={16} />;

export const IconReattach = () => (
	<svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3">
		<path
			d="M6 12H3a1 1 0 01-1-1V4a1 1 0 011-1h7a1 1 0 011 1v3M10 8l-4 4M10 12V8H6"
			stroke-linecap="round"
			stroke-linejoin="round"
		/>
	</svg>
);

// SVG close (not the `&times;` glyph) so it shares the geometry and optical
// center of the detach/reattach icons — a text glyph sits a hair higher.
export const IconClose = () => <SharedClose size={16} />;

interface PanelWindowControlsProps {
	panelId: string;
	mode: "inline" | "detached";
	onInlineClose?: () => void;
}

export const PanelWindowControls: Component<PanelWindowControlsProps> = (props) => {
	return (
		<div class={s.controls}>
			<Show when={props.mode === "inline" && isTauri()}>
				<button class={s.btn} onClick={() => detachPanel(props.panelId)} title="Open in separate window">
					<IconDetach />
				</button>
			</Show>
			<Show when={props.mode === "detached"}>
				<button class={s.btn} onClick={() => reattachPanel(props.panelId)} title="Bring back to main window">
					<IconReattach />
				</button>
			</Show>
			<button
				class={s.btn}
				onClick={() => (props.mode === "detached" ? closePanel(props.panelId) : props.onInlineClose?.())}
				title="Close"
			>
				<IconClose />
			</button>
		</div>
	);
};
