import { render } from "solid-js/web";
import commander from "../../../../src-tauri/src/themes/commander.json";
import paper from "../../../../src-tauri/src/themes/vscode-light.json";
import { QuestionBanner } from "../../components/QuestionBanner";
import { SessionsScreen } from "../../screens/SessionsScreen";
import type { SessionInfo } from "../../useSessions";
import "../../mobile.css";

// Presentational state only: no live backend, preferences, or session mutations.
const sessions: SessionInfo[] = ["Reviewer", "Builder"].map((name, i) => ({
	session_id: `contrast-${i}`,
	display_name: name,
	cwd: "/fixture/tuicommander",
	worktree_path: null,
	worktree_branch: "fix/light-contrast",
	state: {
		agent_type: "ego",
		awaiting_input: true,
		question_text: "Which option should I use?",
		rate_limited: false,
		shell_state: "idle",
		last_activity_ms: Date.now(),
	},
}));
const light = new URLSearchParams(location.search).get("theme") !== "dark";
const theme = (light ? paper : commander).appChrome;
document.documentElement.dataset.theme = light ? "vscode-light" : "commander";
for (const [key, value] of Object.entries({
	"--bg-primary": theme.background,
	"--bg-secondary": theme.surface,
	"--bg-tertiary": theme.surfaceElevated,
	"--bg-highlight": theme.highlight,
	"--fg-primary": theme.foreground,
	"--fg-secondary": theme.foregroundSecondary,
	"--fg-muted": theme.mutedForeground,
	"--accent": theme.accent,
	"--border": theme.border,
	"--warning": theme.warning,
}))
	document.documentElement.style.setProperty(key, value);
const root = document.getElementById("mobile-app")!;
root.style.cssText = "height:100dvh;display:flex;flex-direction:column;background:var(--bg-primary)";
render(
	() => (
		<>
			<QuestionBanner sessions={sessions} onNavigate={() => {}} />
			<SessionsScreen
				sessions={sessions}
				loading={false}
				refreshing={false}
				error={null}
				onRefresh={() => {}}
				onSelectSession={() => {}}
			/>
		</>
	),
	root,
);
