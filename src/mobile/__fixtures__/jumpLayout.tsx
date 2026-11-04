/** Real mobile components with inert transport: geometry, not session evidence. */
import { render } from "solid-js/web";
import { CommandInput } from "../components/CommandInput";
import { MobileJumpBottom } from "../components/MobileJumpBottom";
import { TerminalKeybar } from "../components/TerminalKeybar";
import styles from "../screens/SessionDetailScreen.module.css";
import "../mobile.css";

render(
	() => (
		<section style={{ display: "flex", "flex-direction": "column", height: "100dvh" }}>
			<div class={styles.outputArea} data-output-area>
				Earlier terminal output
				<MobileJumpBottom visible onScrollToBottom={() => {}} />
			</div>
			<TerminalKeybar sessionId="layout-only" sessionExists={false} />
			<CommandInput sessionId="layout-only" sessionExists={false} />
		</section>
	),
	document.getElementById("mobile-app")!,
);
