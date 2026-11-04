/** Isolated actual Workspace pages. All state and RPC are illustrative, not live evidence. */
import { createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import commander from "../../../../src-tauri/src/themes/commander.json";
import paper from "../../../../src-tauri/src/themes/vscode-light.json";
import "../../../global.css";
import { Input } from "../../ui/Input";
import { SettingsShell } from "../SettingsShell";
import { GitHubTab } from "../tabs/GitHubTab";
import { KeyboardShortcutsTab } from "../tabs/KeyboardShortcutsTab";
import { TerminalTab } from "../tabs/TerminalTab";

const theme = new URLSearchParams(location.search).get("theme") === "light" ? paper : commander;
const tokens: Record<string, string> = {
	background: "bg-primary",
	surface: "bg-secondary",
	surfaceElevated: "bg-tertiary",
	highlight: "bg-highlight",
	foreground: "fg-primary",
	foregroundSecondary: "fg-secondary",
	mutedForeground: "fg-muted",
	accentHover: "accent-hover",
	accentForeground: "text-on-accent",
	errorForeground: "text-on-error",
};
for (const [key, value] of Object.entries(theme.appChrome))
	document.documentElement.style.setProperty(`--${tokens[key] ?? key}`, String(value));
document.body.style.margin = "0";

function Preview() {
	const [query, setQuery] = createSignal("");
	const [tab, setTab] = createSignal(new URLSearchParams(location.search).get("tab") ?? "terminal");
	return (
		<SettingsShell
			visible
			title="Settings · isolated fixture"
			onClose={() => {}}
			navHeader={
				<Input
					aria-label="Find a page"
					placeholder="Find a page..."
					value={query()}
					onInput={(event) => setQuery(event.currentTarget.value)}
				/>
			}
			activeTab={tab()}
			onTabChange={setTab}
			tabs={[
				{ key: "__label__:app", label: "Workspace" },
				{ key: "terminal", label: "Terminal" },
				{ key: "keyboard", label: "Keyboard Shortcuts" },
				{ key: "github", label: "Git & GitHub" },
			].filter((item) => item.key.startsWith("__label__:") || item.label.toLowerCase().includes(query().toLowerCase()))}
		>
			<Show when={tab() === "terminal"}>
				<TerminalTab />
			</Show>
			<Show when={tab() === "keyboard"}>
				<KeyboardShortcutsTab />
			</Show>
			<Show when={tab() === "github"}>
				<GitHubTab />
			</Show>
		</SettingsShell>
	);
}
render(() => <Preview />, document.getElementById("preview")!);
