import type { Component } from "solid-js";
import { invoke } from "../invoke";
import { appLogger } from "../stores/appLogger";
import { uiStore } from "../stores/ui";
import { isTauri } from "../transport";

export interface DetachedPlaceholderProps {
	panel: string;
	panelId: string;
}

export const DetachedPlaceholder: Component<DetachedPlaceholderProps> = (props) => {
	const handleBringBack = async () => {
		if (!isTauri()) return;
		try {
			await invoke("close_panel_window", { panelId: props.panelId });
		} catch (e) {
			appLogger.warn("app", "Failed to close detached window", { error: String(e) });
		}
		uiStore.clearDetached(props.panelId);
	};

	return (
		<div
			style={{
				display: "flex",
				"flex-direction": "column",
				"align-items": "center",
				"justify-content": "center",
				gap: "12px",
				width: "300px",
				"min-width": "200px",
				height: "100%",
				background: "var(--bg-primary)",
				"border-left": "1px solid var(--border)",
				color: "var(--fg-secondary)",
				"font-size": "13px",
			}}
		>
			<svg width="24" height="24" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="1.3">
				<path
					d="M8 2h4v4M8 6l4-4M6 3H3a1 1 0 00-1 1v7a1 1 0 001 1h7a1 1 0 001-1V8"
					stroke-linecap="round"
					stroke-linejoin="round"
				/>
			</svg>
			<span>{props.panel} is in a separate window</span>
			<button
				onClick={handleBringBack}
				style={{
					padding: "4px 12px",
					background: "var(--bg-tertiary)",
					color: "var(--fg-primary)",
					border: "1px solid var(--border)",
					"border-radius": "4px",
					cursor: "pointer",
					"font-size": "12px",
				}}
			>
				Bring back
			</button>
		</div>
	);
};
