import { type Component, createSignal, onCleanup, Show } from "solid-js";
import { appLogger } from "../../stores/appLogger";
import { writeClipboard } from "../../utils/clipboard";

export interface CrashScreenProps {
	/** e.g. "FastAF crashed" (desktop) vs "FastAF Mobile crashed" */
	title: string;
	error: Error;
}

/**
 * Last-resort fallback rendered by the root `ErrorBoundary` in both the desktop
 * (`src/index.tsx`) and mobile (`src/mobile/index.tsx`) entrypoints. Shared here
 * so the two stay behaviorally identical and so the copy/feedback logic has one
 * place to test — inline styles only, since a crash is exactly the moment a CSS
 * Module chunk might not have loaded.
 */
export const CrashScreen: Component<CrashScreenProps> = (props) => {
	const [copyState, setCopyState] = createSignal<"idle" | "copied" | "failed">("idle");
	let resetTimer: ReturnType<typeof setTimeout> | undefined;
	// The reset timer outlives the component if the boundary re-renders (Reload
	// tears the tree down while it is pending), and it writes to a disposed
	// signal when it fires.
	onCleanup(() => clearTimeout(resetTimer));

	const stack = () => props.error.stack ?? "";
	// This exact string is what goes to the clipboard — it must match the two
	// <pre> blocks below (message, then full stack) with nothing truncated on
	// either side, since Boss pastes it straight into a bug report.
	const diagnosticText = () => (stack() ? `${props.error.message}\n\n${stack()}` : props.error.message);

	const handleCopy = () => {
		writeClipboard(diagnosticText())
			.then(() => setCopyState("copied"))
			.catch((err) => {
				appLogger.error("app", "Failed to copy crash diagnostic", err);
				setCopyState("failed");
			})
			.finally(() => {
				clearTimeout(resetTimer);
				resetTimer = setTimeout(() => setCopyState("idle"), 2000);
			});
	};

	return (
		<div
			style={{
				padding: "24px",
				"font-family": "monospace",
				color: "var(--error, #f44)",
				background: "var(--bg-primary, #1e1e1e)",
				height: "100vh",
				overflow: "auto",
			}}
		>
			<h2 style={{ margin: "0 0 12px" }}>{props.title}</h2>
			<pre style={{ "white-space": "pre-wrap", color: "var(--fg-primary, #ccc)" }}>{props.error.message}</pre>
			<pre style={{ "white-space": "pre-wrap", color: "var(--fg-muted, #888)", "font-size": "12px" }}>{stack()}</pre>
			<div style={{ display: "flex", gap: "8px", "align-items": "center", "margin-top": "16px" }}>
				<button
					type="button"
					style={{
						padding: "8px 16px",
						background: "var(--bg-tertiary, #333)",
						color: "var(--fg-primary, #fff)",
						border: "1px solid var(--border, #555)",
						"border-radius": "4px",
						cursor: "pointer",
					}}
					onClick={() => location.reload()}
				>
					Reload
				</button>
				<button
					type="button"
					style={{
						padding: "8px 16px",
						background: "var(--bg-tertiary, #333)",
						color: "var(--fg-primary, #fff)",
						border: "1px solid var(--border, #555)",
						"border-radius": "4px",
						cursor: "pointer",
					}}
					onClick={handleCopy}
				>
					Copy error
				</button>
				<Show when={copyState() === "copied"}>
					<span style={{ color: "var(--success, #4ec9b0)" }}>Copied</span>
				</Show>
				<Show when={copyState() === "failed"}>
					<span style={{ color: "var(--error, #f48771)" }}>Copy failed</span>
				</Show>
			</div>
		</div>
	);
};
