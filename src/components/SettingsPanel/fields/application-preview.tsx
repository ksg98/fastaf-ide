/** Isolated actual Application tabs; Vite aliases state to an illustrative fixture. */
import { createSignal, Show } from "solid-js";
import { render } from "solid-js/web";
import commander from "../../../../src-tauri/src/themes/commander.json";
import paper from "../../../../src-tauri/src/themes/vscode-light.json";
import "../../../global.css";
import { Input } from "../../ui/Input";
import { AllSettingsTab } from "../AllSettingsTab";
import { SettingsShell } from "../SettingsShell";
import { AppearanceTab } from "../tabs/AppearanceTab";
import { GeneralTab } from "../tabs/GeneralTab";
import { NotificationsTab } from "../tabs/NotificationsTab";

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
	const [tab, setTab] = createSignal(new URLSearchParams(location.search).get("tab") ?? "general");
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
				{ key: "__label__:app", label: "Application" },
				{ key: "general", label: "General" },
				{ key: "all-settings", label: "All settings (Expert)" },
				{ key: "appearance", label: "Appearance" },
				{ key: "notifications", label: "Notifications" },
			].filter((item) => item.key.startsWith("__label__:") || item.label.toLowerCase().includes(query().toLowerCase()))}
		>
			<Show when={tab() === "all-settings"}>
				<AllSettingsTab initialSetting="app.services.auth.auth_rate_limit_max" />
			</Show>
			<Show when={tab() === "general"}>
				<GeneralTab />
			</Show>
			<Show when={tab() === "appearance"}>
				<AppearanceTab />
			</Show>
			<Show when={tab() === "notifications"}>
				<NotificationsTab />
			</Show>
		</SettingsShell>
	);
}
render(() => <Preview />, document.getElementById("preview")!);
