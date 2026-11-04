import { fireEvent, render, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockInvoke } from "../../../__tests__/mocks/tauri";

vi.mock("../../../stores/settings", () => ({
	settingsStore: {
		state: { ide: "vscode", font: "JetBrains Mono", defaultFontSize: 12, customLaunchers: [] },
		setIde: vi.fn(),
		setFont: vi.fn(),
		isAiChatEnabled: vi.fn().mockReturnValue(false),
		isAcpConfigured: vi.fn().mockReturnValue(false),
	},
	IDE_NAMES: { vscode: "VS Code" },
	FONT_FAMILIES: { "JetBrains Mono": "JetBrains Mono" },
}));

vi.mock("../../../stores/ui", async () => {
	const { createStore } = await import("solid-js/store");
	const [state, setState] = createStore({ settingsNavWidth: 180, settingsExpertMode: false });
	return {
		uiStore: {
			state,
			setSettingsNavWidth: vi.fn(),
			persistUIPrefs: vi.fn(),
			setSettingsExpertMode: vi.fn((enabled: boolean) => setState("settingsExpertMode", enabled)),
		},
	};
});

vi.mock("../../../stores/repositories", () => ({
	repositoriesStore: {
		state: { repositories: {}, repoOrder: [] },
		setDisplayName: vi.fn(),
		getGroupForRepo: vi.fn(() => undefined),
		getAllReposOrdered: vi.fn(() => []),
		getConnectionId: vi.fn(() => undefined),
	},
}));

vi.mock("../../../stores/repoSettings", () => ({
	repoSettingsStore: { get: vi.fn(() => undefined), getOrCreate: vi.fn(), update: vi.fn(), reset: vi.fn() },
}));

// A test-only expert control stands in for the Notifications page, so the
// mechanism is exercised without deciding which real control is expert.
vi.mock("../tabs", async (importOriginal) => {
	const { ExpertSection, ExpertSetting } = await import("../ExpertSetting");
	return {
		...(await importOriginal<typeof import("../tabs")>()),
		NotificationsTab: () => (
			<ExpertSection>
				<h3>Test Expert Section</h3>
				<ExpertSetting configKey="app.osc52_clipboard" value={true}>
					<label>Test expert control</label>
				</ExpertSetting>
			</ExpertSection>
		),
	};
});

vi.mock("../settingsSearchIndex", async (importOriginal) => {
	const real = await importOriginal<typeof import("../settingsSearchIndex")>();
	const entry = {
		tab: "notifications",
		section: "Test Expert Section",
		label: "Test expert control",
		expert: true,
		configKey: "app.osc52_clipboard",
	};
	return {
		...real,
		searchSettings: (query: string, tabs: ReadonlySet<string>, client: "desktop" | "browser") =>
			query === "test expert" ? [entry] : real.searchSettings(query, tabs, client),
	};
});

import { uiStore } from "../../../stores/ui";
import { SettingsPanel } from "../SettingsPanel";

const DEFAULTS = {
	app: { osc52_clipboard: true, background: { webview_unload_minutes: 10 } },
	notifications: {},
	agent_settings: {},
};

const searchInput = (container: HTMLElement) => container.querySelector("nav input[type='text']") as HTMLInputElement;
const expertSwitch = (container: HTMLElement) =>
	container.querySelector("input[role='switch']") as HTMLInputElement | null;
const navButton = (container: HTMLElement, label: string) =>
	[...container.querySelectorAll("nav button")].find((b) => b.textContent === label) as HTMLElement;
const expertLabel = (container: HTMLElement) =>
	[...container.querySelectorAll("label")].find((el) => el.textContent === "Test expert control");

describe("SettingsPanel expert mode", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		uiStore.setSettingsExpertMode(false);
		vi.mocked(uiStore.setSettingsExpertMode).mockClear();
		mockInvoke.mockImplementation((cmd: string) =>
			cmd === "get_config_defaults" ? Promise.resolve(DEFAULTS) : Promise.resolve(undefined),
		);
	});

	it("loads the config defaults when Settings opens", () => {
		render(() => <SettingsPanel visible={true} onClose={() => {}} />);
		expect(mockInvoke.mock.calls.map((call) => call[0])).toContain("get_config_defaults");
	});

	it("hides an expert control at its default in basic mode and shows it in expert mode", async () => {
		const { container } = render(() => <SettingsPanel visible={true} onClose={() => {}} initialTab="notifications" />);
		await waitFor(() => expect(expertLabel(container)).toBeUndefined());

		fireEvent.click(expertSwitch(container) as HTMLInputElement);
		expect(uiStore.setSettingsExpertMode).toHaveBeenCalledWith(true);
		expect(expertLabel(container)).toBeDefined();
	});

	it("keeps the Expert switch state across a Settings reopen", () => {
		const [visible, setVisible] = createSignal(true);
		const { container } = render(() => <SettingsPanel visible={visible()} onClose={() => {}} />);
		expect(expertSwitch(container)?.checked).toBe(false);
		fireEvent.click(expertSwitch(container) as HTMLInputElement);

		setVisible(false);
		setVisible(true);
		expect(expertSwitch(container)?.checked).toBe(true);
	});

	it("reveals a hidden expert control opened from search, scrolls to it, and keeps the pref off", async () => {
		const { container } = render(() => <SettingsPanel visible={true} onClose={() => {}} />);
		fireEvent.input(searchInput(container), { target: { value: "test expert" } });
		const row = container.querySelector("button[class*='searchResult']") as HTMLElement;
		expect(row.querySelector("[data-expert-badge]")).not.toBeNull();

		fireEvent.click(row);
		const label = expertLabel(container);
		expect(label).toBeDefined();
		const onScroll = vi.fn();
		if (label) label.scrollIntoView = onScroll;
		await waitFor(() => expect(onScroll).toHaveBeenCalled());

		expect(uiStore.state.settingsExpertMode).toBe(false);
		expect(uiStore.setSettingsExpertMode).not.toHaveBeenCalled();
	});

	it("finds an expert setting with its badge in expert mode too", () => {
		uiStore.setSettingsExpertMode(true);
		const { container } = render(() => <SettingsPanel visible={true} onClose={() => {}} />);
		fireEvent.input(searchInput(container), { target: { value: "test expert" } });
		const row = container.querySelector("button[class*='searchResult']") as HTMLElement | null;
		expect(row?.querySelector("[data-expert-badge]")?.textContent).toBe("Expert");
	});

	it("forgets a search reveal when Settings is reopened", async () => {
		const [visible, setVisible] = createSignal(true);
		const { container } = render(() => <SettingsPanel visible={visible()} onClose={() => {}} />);
		fireEvent.input(searchInput(container), { target: { value: "test expert" } });
		fireEvent.click(container.querySelector("button[class*='searchResult']") as HTMLElement);
		expect(expertLabel(container)).toBeDefined();

		setVisible(false);
		setVisible(true);
		fireEvent.click(navButton(container, "Notifications"));
		await waitFor(() => expect(expertLabel(container)).toBeUndefined());
	});
});
