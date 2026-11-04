import "@testing-library/jest-dom/vitest";
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DictationSettings } from "../../../components/SettingsPanel/DictationSettings";
import { AppearanceTab } from "../../../components/SettingsPanel/tabs/AppearanceTab";
import { GeneralTab } from "../../../components/SettingsPanel/tabs/GeneralTab";
import { GitHubTab } from "../../../components/SettingsPanel/tabs/GitHubTab";
import { NotificationsTab } from "../../../components/SettingsPanel/tabs/NotificationsTab";
import { PluginsTab } from "../../../components/SettingsPanel/tabs/PluginsTab";
import { RepoWorktreeTab } from "../../../components/SettingsPanel/tabs/RepoWorktreeTab";
import { SmartPromptsTab } from "../../../components/SettingsPanel/tabs/SmartPromptsTab";
import { RemoteAccessPanel } from "../../../components/SettingsPanel/tabs/services/RemoteAccessPanel";
import { TelegramTab } from "../../../components/SettingsPanel/tabs/TelegramTab";
import { TerminalTab } from "../../../components/SettingsPanel/tabs/TerminalTab";
import { repoDefaultsStore } from "../../../stores/repoDefaults";
import { repoSettingsStore } from "../../../stores/repoSettings";
import { mockInvoke } from "../../mocks/tauri";

vi.mock("../../../stores/appLogger", () => ({
	appLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
	vi.useFakeTimers();
	// Backend reads are incidental; no live service participates in the copy contract.
	mockInvoke.mockResolvedValue(undefined);
});
afterEach(async () => {
	cleanup();
	await vi.runOnlyPendingTimersAsync();
	vi.useRealTimers();
});

describe("Settings subtitle copy", () => {
	// Catches: a card inventory returning as permanent page-header narration.
	it.each([
		["General", "Application behavior, updates and local tools.", () => <GeneralTab />],
		["Appearance", "Tabs, chat presentation and repository groups.", () => <AppearanceTab />],
		["Notifications", "Audio alerts, visual notices and operating-system notifications.", () => <NotificationsTab />],
		["Terminal", "Configure terminal typography, preview, and behavior.", () => <TerminalTab />],
		["Git & GitHub", "Manage accounts, monitoring, and defaults for your repositories.", () => <GitHubTab />],
		["Manage plugins", "Manage installed plugins and browse the community registry.", () => <PluginsTab />],
		[
			"Repository",
			"Configure repository identity and inherited worktree defaults.",
			() => (
				<RepoWorktreeTab
					settings={repoSettingsStore.getOrCreate("/subtitle-test", "Repository")}
					defaults={repoDefaultsStore.state}
					onUpdate={() => {}}
				/>
			),
		],
		["Telegram", "Bot setup and authorized chats on this machine.", () => <TelegramTab />],
		["Remote Access", "Web access, authentication and relay settings for this machine.", () => <RemoteAccessPanel />],
		[
			"Dictation",
			"Dictation, speech recognition and spoken conversations on this machine.",
			() => <DictationSettings />,
		],
		["Smart Prompts", "Configure reusable actions and their execution behavior.", () => <SmartPromptsTab />],
	] as const)("does not enumerate cards under %s", (heading, copy, mount) => {
		const view = render(mount);
		expect(view.getByRole("heading", { level: 2, name: heading })).toBeInTheDocument();
		expect(view.queryByText(copy)).not.toBeInTheDocument();
	});
});
