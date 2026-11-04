import { fireEvent, render } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockInvoke } from "../mocks/tauri";

vi.mock("../../stores/settings", () => ({
	settingsStore: {
		state: {
			customLaunchers: [],
			ide: "vscode",
			font: "JetBrains Mono",
			defaultFontSize: 12,
			confirmBeforeQuit: true,
			confirmBeforeClosingTab: true,
		},
		setIde: vi.fn(),
		setFont: vi.fn(),
		setConfirmBeforeQuit: vi.fn(),
		setConfirmBeforeClosingTab: vi.fn(),
		isAiChatEnabled: vi.fn().mockReturnValue(false),
		isAcpConfigured: vi.fn().mockReturnValue(false),
	},
	IDE_NAMES: { vscode: "VS Code", cursor: "Cursor" },
	FONT_FAMILIES: { "JetBrains Mono": "JetBrains Mono", "Fira Code": "Fira Code" },
}));

vi.mock("../../stores/notifications", () => ({
	notificationsStore: {
		state: {
			isAvailable: true,
			config: {
				enabled: true,
				volume: 0.5,
				sounds: {
					question: true,
					error: true,
					completion: true,
					warning: true,
				},
			},
		},
		setEnabled: vi.fn(),
		setVolume: vi.fn(),
		setSoundEnabled: vi.fn(),
		testSound: vi.fn(),
		reset: vi.fn(),
	},
}));

vi.mock("../../stores/ui", async () => {
	const { createStore } = await import("solid-js/store");
	const [state, setState] = createStore({
		settingsNavWidth: 180,
		tasksViewPreferences: {},
		settingsExpertMode: false,
	});
	return {
		uiStore: {
			state,
			setSettingsNavWidth: vi.fn(),
			setSettingsExpertMode: (enabled: boolean) => setState("settingsExpertMode", enabled),
		},
	};
});

vi.mock("../../stores/repositories", () => {
	const repositories = {
		"/repo/alpha": { path: "/repo/alpha", displayName: "Alpha" },
		"/repo/beta": { path: "/repo/beta", displayName: "Beta" },
	};
	const repoOrder = ["/repo/alpha", "/repo/beta"];
	return {
		repositoriesStore: {
			state: { repositories, repoOrder },
			setDisplayName: vi.fn(),
			getGroupForRepo: vi.fn(() => undefined),
			getAllReposOrdered: vi.fn(() => repoOrder.map((p) => repositories[p as keyof typeof repositories])),
		},
	};
});

vi.mock("../../stores/repoSettings", () => ({
	repoSettingsStore: {
		get: vi.fn(() => undefined),
		getOrCreate: vi.fn().mockReturnValue({
			path: "/repo/alpha",
			displayName: "Alpha",
			baseBranch: "automatic",
			copyIgnoredFiles: false,
			copyUntrackedFiles: false,
			setupScript: "",
			runScript: "",
			color: "",
		}),
		update: vi.fn(),
		reset: vi.fn(),
	},
}));

import { SettingsPanel } from "../../components/SettingsPanel/SettingsPanel";
import { appLogger } from "../../stores/appLogger";
import { settingsStore } from "../../stores/settings";
import { uiStore } from "../../stores/ui";

/** Nav items keyed by the group label row above them, in rendered order. */
function navGroups(container: HTMLElement): Record<string, string[]> {
	const groups: Record<string, string[]> = {};
	let current = "";
	for (const el of container.querySelectorAll(".navLabel, .navItem")) {
		const text = el.textContent ?? "";
		if (el.classList.contains("navLabel")) {
			current = text;
			groups[current] = [];
		} else {
			(groups[current] ??= []).push(text);
		}
	}
	return groups;
}

describe("SettingsPanel", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(appLogger, "error").mockImplementation(() => {});
		uiStore.setSettingsExpertMode(false);
	});

	afterEach(() => {
		for (const [source, message] of vi.mocked(appLogger.error).mock.calls) {
			expect([source, message]).toEqual(["config", "ego perimeter request failed"]);
		}
		vi.mocked(appLogger.error).mockRestore();
	});

	it("does not render when visible=false", () => {
		const { container } = render(() => <SettingsPanel visible={false} onClose={() => {}} />);
		const overlay = container.querySelector(".overlay");
		expect(overlay).toBeNull();
	});

	it("renders when visible=true", () => {
		const { container } = render(() => <SettingsPanel visible={true} onClose={() => {}} />);
		const overlay = container.querySelector(".overlay");
		expect(overlay).not.toBeNull();
	});

	it("shows Settings header", () => {
		const { container } = render(() => <SettingsPanel visible={true} onClose={() => {}} />);
		const heading = container.querySelector(".header h2");
		expect(heading).not.toBeNull();
		expect(heading!.textContent).toBe("Settings");
	});

	it("shows nav items (General, Notifications)", () => {
		const { container } = render(() => <SettingsPanel visible={true} onClose={() => {}} />);
		const navItems = container.querySelectorAll(".navItem");
		const labels = Array.from(navItems).map((n) => n.textContent);
		expect(labels).toContain("General");
		expect(labels).toContain("Appearance");
		expect(labels).toContain("Notifications");
		expect(labels).toContain("Agents");
		expect(labels).not.toContain("Groups");
	});

	it("shows the Terminal, Keyboard Shortcuts and Dictation nav items, and no Developer Tools page", () => {
		const { container } = render(() => <SettingsPanel visible={true} onClose={() => {}} />);
		const navItems = container.querySelectorAll(".navItem");
		const labels = Array.from(navItems).map((n) => n.textContent);
		expect(labels).toContain("Terminal");
		expect(labels).not.toContain("Developer Tools");
		expect(labels).toContain("Keyboard Shortcuts");
		// FastAF keeps the Dictation label: "Voice" is its separate voice-agent
		// page (desktop only; this test runs as the desktop app).
		expect(labels).toContain("Dictation");
		expect(labels).toContain("Voice");
	});

	it("hides the AI Chat nav item while the feature flag is off", () => {
		const { container } = render(() => <SettingsPanel visible={true} onClose={() => {}} />);
		const navItems = container.querySelectorAll(".navItem");
		const labels = Array.from(navItems).map((n) => n.textContent);
		expect(labels).not.toContain("AI Chat");
		// Providers also serve dictation rewrite, Smart Prompts and PR review.
		expect(labels).toContain("Providers");
	});

	it("shows the shortcut editor when the Keyboard Shortcuts nav item is active", () => {
		const { container } = render(() => <SettingsPanel visible={true} onClose={() => {}} />);
		const navItems = container.querySelectorAll(".navItem");
		const item = Array.from(navItems).find((n) => n.textContent === "Keyboard Shortcuts")!;
		fireEvent.click(item);

		const heading = container.querySelector(".section h2");
		expect(heading!.textContent).toBe("Keyboard Shortcuts");
		// Reused from HelpPanel's KeyboardShortcutsTab — same shortcut rows render here.
		expect(container.querySelectorAll("kbd").length).toBeGreaterThan(0);
	});

	it("close button calls onClose", () => {
		const onClose = vi.fn();
		const { container } = render(() => <SettingsPanel visible={true} onClose={onClose} />);
		const closeBtn = container.querySelector(".close")!;
		fireEvent.click(closeBtn);
		expect(onClose).toHaveBeenCalledOnce();
	});

	it("overlay click calls onClose", () => {
		const onClose = vi.fn();
		const { container } = render(() => <SettingsPanel visible={true} onClose={onClose} />);
		const overlay = container.querySelector(".overlay")!;
		fireEvent.click(overlay);
		expect(onClose).toHaveBeenCalledOnce();
	});

	it("switching nav items shows correct content", () => {
		const { container } = render(() => <SettingsPanel visible={true} onClose={() => {}} />);

		// Default is General (terminal fields moved to the Terminal tab)
		const headings = container.querySelectorAll(".section h3");
		expect(headings.length).toBeGreaterThanOrEqual(3);
		// Use childNodes[0] to get heading text without tooltip content
		const headingTexts = Array.from(headings).map((h) => h.childNodes[0]?.textContent?.trim() ?? "");
		expect(headingTexts).toContain("General");
		expect(headingTexts).toContain("Confirmations");
		expect(headingTexts).toContain("Updates");

		// Click Notifications nav item
		const navItems = container.querySelectorAll(".navItem");
		const notificationsItem = Array.from(navItems).find((n) => n.textContent === "Notifications")!;
		fireEvent.click(notificationsItem);
		const sectionTitle = container.querySelector(".section h3");
		expect(sectionTitle!.textContent).toBe("Notification Settings");
	});

	it("shows repos as nav items in the sidebar", () => {
		const { container } = render(() => <SettingsPanel visible={true} onClose={() => {}} />);
		const repoItems = container.querySelectorAll(".navItemRepo");
		const labels = Array.from(repoItems).map((n) => n.textContent);
		expect(labels).toContain("Alpha");
		expect(labels).toContain("Beta");
	});

	it("shows the Repositories section label above repo items", () => {
		const { container } = render(() => <SettingsPanel visible={true} onClose={() => {}} />);
		expect(navGroups(container).Repositories).toEqual(["Alpha", "Beta"]);
	});

	it("puts every global page under its task group, one direct item each", () => {
		const { container } = render(() => <SettingsPanel visible={true} onClose={() => {}} />);
		expect(navGroups(container)).toEqual({
			// The raw catalogue page is the Expert page: hidden while Expert is off.
			Application: ["General", "Appearance", "Notifications"],
			Workspace: ["Terminal", "Keyboard Shortcuts", "Git & GitHub"],
			// FastAF keeps its own Providers page, calls the dictation page
			// Dictation, and adds its voice-agent page (Voice).
			AI: ["Agents", "Providers", "Dictation", "Voice", "Smart Prompts"],
			Integrations: ["MCP", "Remote Access", "Remote Machines", "Telegram", "Manage plugins"],
			Repositories: ["Alpha", "Beta"],
		});
	});

	// Catches: "All settings (Expert)" offered in the nav while Expert is off.
	it("lists All settings only while the Expert switch is on", () => {
		const { container } = render(() => <SettingsPanel visible={true} onClose={() => {}} />);
		const expert = container.querySelector<HTMLInputElement>('[data-setting-id="preferences.settings_expert_mode"]')!;
		expect(navGroups(container).Application).not.toContain("All settings (Expert)");
		fireEvent.click(expert);
		expect(navGroups(container).Application).toEqual([
			"General",
			"All settings (Expert)",
			"Appearance",
			"Notifications",
		]);
		fireEvent.click(expert);
		expect(navGroups(container).Application).not.toContain("All settings (Expert)");
	});

	// Catches: switching Expert off on the catalogue page leaves a page the nav no longer lists.
	it("returns to General when Expert is switched off on the All settings page", () => {
		const { container } = render(() => <SettingsPanel visible={true} onClose={() => {}} />);
		const expert = container.querySelector<HTMLInputElement>('[data-setting-id="preferences.settings_expert_mode"]')!;
		fireEvent.click(expert);
		const allSettings = Array.from(container.querySelectorAll(".navItem")).find(
			(n) => n.textContent === "All settings (Expert)",
		)!;
		fireEvent.click(allSettings);
		expect(container.querySelector(".navItem.active")!.textContent).toBe("All settings (Expert)");
		fireEvent.click(expert);
		expect(container.querySelector(".navItem.active")!.textContent).toBe("General");
	});

	it("opens General for the retired developer-tools key, so an old deep link still lands on a page", () => {
		// tuic://settings?tab=developer-tools and any caller written before the
		// page folded into General must not open a blank content area.
		const { container } = render(() => (
			<SettingsPanel visible={true} onClose={() => {}} initialTab="developer-tools" />
		));
		expect(container.querySelector(".navItem.active")!.textContent).toBe("General");
		const headingTexts = Array.from(container.querySelectorAll(".section h3")).map(
			(h) => h.childNodes[0]?.textContent?.trim() ?? "",
		);
		expect(headingTexts).toContain("General");
		expect(headingTexts).toContain("IDE");
	});

	it("opens the successor page for the tab keys this reorganization retired", async () => {
		// services split into MCP / Remote Access / Remote Machines; an old
		// tuic://settings?tab=… link must land on a page. FastAF keeps its own
		// Providers page, so "providers" is not retired and opens it.
		vi.mocked(settingsStore.isAiChatEnabled).mockReturnValue(true);
		mockInvoke.mockImplementation((command: string) => {
			if (command === "load_config") {
				return Promise.resolve({ mcp_capabilities: { denied: [], migration_unknown_tools: [] } });
			}
			if (command === "load_mcp_upstreams") return Promise.resolve({ servers: [] });
			// The Providers page lists headless agents from a detection scan.
			if (command === "detect_all_agent_binaries") return Promise.resolve({});
			return Promise.resolve(undefined);
		});
		try {
			for (const [retired, label] of [
				["services", "MCP"],
				["providers", "Providers"],
			]) {
				const { container, unmount } = render(() => (
					<SettingsPanel visible={true} onClose={() => {}} initialTab={retired} />
				));
				expect(container.querySelector(".navItem.active")?.textContent, retired).toBe(label);
				// Catches: unmounting the MCP page while its load_config continuation is pending.
				if (retired === "services") await vi.waitFor(() => expect(container.textContent).toContain("Capabilities"));
				unmount();
			}
		} finally {
			vi.mocked(settingsStore.isAiChatEnabled).mockReturnValue(false);
		}
	});

	it("lists AI Chat under AI when the feature flag is on", () => {
		vi.mocked(settingsStore.isAiChatEnabled).mockReturnValue(true);
		try {
			const { container } = render(() => <SettingsPanel visible={true} onClose={() => {}} />);
			expect(navGroups(container).AI).toEqual([
				"Agents",
				"AI Chat",
				"Providers",
				"Dictation",
				"Voice",
				"Smart Prompts",
			]);
		} finally {
			vi.mocked(settingsStore.isAiChatEnabled).mockReturnValue(false);
		}
	});

	it("opens a repository's settings from its grouped nav entry", () => {
		const { container } = render(() => <SettingsPanel visible={true} onClose={() => {}} />);
		const beta = Array.from(container.querySelectorAll(".navItemRepo")).find((n) => n.textContent === "Beta")!;
		fireEvent.click(beta);
		expect(container.querySelector(".navItem.active")!.textContent).toBe("Beta");
		expect(container.querySelector(".section h3")!.textContent).toBe("Repository");
	});

	it("opens on General when no context given", () => {
		const { container } = render(() => <SettingsPanel visible={true} onClose={() => {}} />);
		const activeItem = container.querySelector(".navItem.active");
		expect(activeItem!.textContent).toBe("General");
	});

	it("opens directly on repo nav item when context is repo", () => {
		const { container } = render(() => (
			<SettingsPanel visible={true} onClose={() => {}} context={{ kind: "repo", repoPath: "/repo/alpha" }} />
		));
		const activeItem = container.querySelector(".navItem.active");
		expect(activeItem!.classList.contains("navItemRepo")).toBe(true);
		expect(activeItem!.textContent).toBe("Alpha");
	});

	it("shows repo settings content when repo nav item is active", () => {
		const { container } = render(() => (
			<SettingsPanel visible={true} onClose={() => {}} context={{ kind: "repo", repoPath: "/repo/alpha" }} />
		));
		// RepoWorktreeTab has a h3 "Repository"
		const h3 = container.querySelector(".section h3");
		expect(h3!.textContent).toBe("Repository");
	});

	// Catches: closing the repository help scope before RepoScriptsTab hides every approved script explanation.
	it("keeps repository script help inside the real SettingsPanel page scope", () => {
		const view = render(() => (
			<SettingsPanel visible={true} onClose={() => {}} context={{ kind: "repo", repoPath: "/repo/alpha" }} />
		));
		for (const [label, guidance] of [
			["Dev Server URL", "An unsuitable selection changes the displayed behavior"],
			["Setup Script", "Use it for repository-specific setup."],
			["Run Script", "Set it for a repeatable development command."],
			["Archive Script", "Use it when cleanup is required before removal."],
		]) {
			const badge = view.getByRole("button", { name: `Explain ${label}` });
			fireEvent.click(badge);
			const tip = document.getElementById(badge.getAttribute("aria-describedby")!);
			expect(tip?.textContent).toContain(guidance);
			expect(tip?.getAttribute("data-visible")).toBe("true");
			fireEvent.keyDown(document, { key: "Escape" });
			expect(tip?.getAttribute("data-visible")).toBeNull();
		}
		expect((view.getByLabelText("Setup Script") as HTMLTextAreaElement).value).toBe("");
		expect((view.getByLabelText("Run Script") as HTMLTextAreaElement).value).toBe("");
		expect((view.getByLabelText("Archive Script") as HTMLTextAreaElement).value).toBe("");
	});

	it("shows Reset to Defaults button only when repo nav item is active", () => {
		const { container } = render(() => <SettingsPanel visible={true} onClose={() => {}} />);
		// Global context → no Reset button
		expect(container.querySelector(".footerReset")).toBeNull();
	});

	it("shows Reset to Defaults when repo nav item is active", () => {
		const { container } = render(() => (
			<SettingsPanel visible={true} onClose={() => {}} context={{ kind: "repo", repoPath: "/repo/alpha" }} />
		));
		expect(container.querySelector(".footerReset")).not.toBeNull();
	});
});
