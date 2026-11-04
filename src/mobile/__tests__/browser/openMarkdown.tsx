import { render } from "solid-js/web";
import { SessionDetailScreen } from "../../screens/SessionDetailScreen";
import "../../mobile.css";

// Screenshot fixture only. The HTTP/SSE boundary is covered by Rust and Vitest.
window.fetch = async () => new Response(JSON.stringify({ lines: [], screen: [], total_lines: 0 }));
document.getElementById("root")!.style.cssText = "height:100dvh;display:flex;flex-direction:column";
render(
	() => (
		<SessionDetailScreen
			subscribeChatWake={() => () => {}}
			session={{
				session_id: "visual-fixture",
				cwd: "/repo/tuicommander",
				worktree_path: null,
				worktree_branch: null,
				state: { awaiting_input: false, rate_limited: false, last_activity_ms: Date.now() },
			}}
			sessionExists
			onBack={() => {}}
			onOpenFiles={() => {}}
		/>
	),
	document.getElementById("root")!,
);
