/** Isolated actual Agents page. All state and RPC are illustrative, not live evidence. */
import { createSignal } from "solid-js";
import { render } from "solid-js/web";
import commander from "../../../../src-tauri/src/themes/commander.json";
import paper from "../../../../src-tauri/src/themes/vscode-light.json";
import "../../../global.css";
import { Input } from "../../ui/Input";
import { SettingsShell } from "../SettingsShell";
import { AgentsTab } from "../tabs/AgentsTab";

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
	const [tab, setTab] = createSignal(new URLSearchParams(location.search).get("tab") ?? "agents");
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
			tabs={[{ key: "agents", label: "Agents" }]}
		>
			<AgentsTab />
		</SettingsShell>
	);
}
render(() => <Preview />, document.getElementById("preview")!);
