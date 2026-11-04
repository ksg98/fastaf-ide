import { render } from "solid-js/web";
import { MobileToastContainer } from "../../components/MobileToastContainer";
import { FilesScreen } from "../../screens/FilesScreen";
import "../../mobile.css";

// Visual fixture only: the real FilesScreen and ReviewableMarkdown, with an isolated RPC boundary.
document.getElementById("root")!.style.cssText = "height:100dvh;display:flex;flex-direction:column";
render(
	() => (
		<>
			<MobileToastContainer />
			<FilesScreen
				sessions={[
					{
						session_id: "review-agent",
						cwd: "/repo",
						worktree_path: null,
						worktree_branch: null,
						display_name: "Review agent",
						state: { agent_type: "ego", awaiting_input: false, rate_limited: false, last_activity_ms: 0 },
					},
				]}
				initialSessionId="review-agent"
				initialRepo={{ cwd: "/repo", worktreePath: null }}
				initialLink={{ candidate: "review.md" }}
			/>
		</>
	),
	document.getElementById("root")!,
);
