/** Rendering benchmark: a real mobile host and transport with generated bounded snapshots.
 * Synthetic text measures DOM cost, not Claude discovery or backend tail latency. */
import { render } from "solid-js/web";
import { SessionDetailScreen } from "../screens/SessionDetailScreen";
import { useSessions } from "../useSessions";
import "../mobile.css";

const root = document.getElementById("mobile-app");
if (!root) throw new Error("Missing fixture root");
root.style.height = "100dvh";
const sessionId = new URLSearchParams(location.search).get("session") ?? "layout-session";
render(() => {
	const sessions = useSessions();
	return (
		<SessionDetailScreen
			session={{
				session_id: sessionId,
				cwd: "/tmp",
				worktree_path: null,
				worktree_branch: null,
				display_name: "Claude benchmark",
				state: { agent_type: "claude", awaiting_input: false, rate_limited: false, last_activity_ms: 0 },
			}}
			subscribeChatWake={sessions.subscribeChatWake}
			sessionExists
			onBack={() => {}}
			onOpenFiles={() => {}}
		/>
	);
}, root);
