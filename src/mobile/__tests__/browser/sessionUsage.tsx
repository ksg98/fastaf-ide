import { render } from "solid-js/web";
import { SessionDetailScreen } from "../../screens/SessionDetailScreen";
import "../../mobile.css";

// Screenshot fixture only. The HTTP/SSE boundary is covered by Rust and Vitest.
window.fetch = async () => new Response(JSON.stringify({ lines: [], screen: [], total_lines: 0 }));
document.getElementById("root")!.style.cssText =
	"position:fixed;top:44px;height:calc(100dvh - 78px);width:100%;display:flex;flex-direction:column";
render(
	() => (
		<SessionDetailScreen
			subscribeChatWake={() => () => {}}
			session={{
				session_id: "usage-visual-fixture",
				cwd: "/repo/tuicommander",
				worktree_path: null,
				worktree_branch: null,
				state: { agent_type: "ego", awaiting_input: false, rate_limited: false, last_activity_ms: Date.now() },
			}}
			sessionExists
			onBack={() => {}}
			onOpenFiles={() => {}}
		/>
	),
	document.getElementById("root")!,
);

// Open only this fixture's menu; no live session or desktop access.
requestAnimationFrame(() => {
	(document.querySelector('[aria-label="More session actions"]') as HTMLButtonElement)?.click();
});

// The reduced containing pane exercises safe areas/browser chrome independently of viewport height.
