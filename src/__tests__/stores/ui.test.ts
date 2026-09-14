import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testInScope, testInScopeAsync } from "../helpers/store";

const mockInvoke = vi.fn().mockResolvedValue(undefined);

vi.mock("@tauri-apps/api/core", () => ({
	invoke: mockInvoke,
}));

describe("uiStore", () => {
	let store: typeof import("../../stores/ui").uiStore;

	beforeEach(async () => {
		vi.useFakeTimers();
		vi.resetModules();
		mockInvoke.mockReset().mockResolvedValue(undefined);
		localStorage.clear();

		vi.doMock("@tauri-apps/api/core", () => ({
			invoke: mockInvoke,
		}));

		store = (await import("../../stores/ui")).uiStore;
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	/** Let the debounced saveUIPrefs fire. */
	function flushPersist(): void {
		vi.advanceTimersByTime(600);
	}

	describe("flushSave", () => {
		// The debounce timer dies with the WebView, so a preference toggled
		// inside its window is lost unless the exit path writes it out.
		it("writes a pending save immediately", () => {
			testInScope(() => {
				store.toggleSidebar();
				expect(mockInvoke).not.toHaveBeenCalledWith("save_ui_prefs", expect.anything());

				store.flushSave();
				expect(mockInvoke).toHaveBeenCalledWith("save_ui_prefs", {
					config: expect.objectContaining({ sidebar_visible: false }),
				});

				// The timer it replaced must not fire a second write.
				mockInvoke.mockClear();
				flushPersist();
				expect(mockInvoke).not.toHaveBeenCalledWith("save_ui_prefs", expect.anything());
			});
		});

		it("does nothing when no save is pending", () => {
			testInScope(() => {
				store.flushSave();
				expect(mockInvoke).not.toHaveBeenCalledWith("save_ui_prefs", expect.anything());
			});
		});
	});

	describe("sidebar", () => {
		it("defaults to visible", () => {
			testInScope(() => {
				expect(store.state.sidebarVisible).toBe(true);
			});
		});

		it("toggleSidebar toggles visibility", () => {
			testInScope(() => {
				store.toggleSidebar();
				expect(store.state.sidebarVisible).toBe(false);
				store.toggleSidebar();
				expect(store.state.sidebarVisible).toBe(true);
			});
		});

		it("persists sidebar state via invoke", () => {
			testInScope(() => {
				store.toggleSidebar();
				flushPersist();
				expect(mockInvoke).toHaveBeenCalledWith("save_ui_prefs", {
					config: expect.objectContaining({ sidebar_visible: false }),
				});
			});
		});

		it("setSidebarVisible sets directly", () => {
			testInScope(() => {
				store.setSidebarVisible(false);
				expect(store.state.sidebarVisible).toBe(false);
			});
		});
	});

	describe("focusMode", () => {
		it("defaults to false", () => {
			testInScope(() => {
				expect(store.state.focusMode).toBe(false);
			});
		});

		it("toggleFocusMode toggles value", () => {
			testInScope(() => {
				store.toggleFocusMode();
				expect(store.state.focusMode).toBe(true);
				store.toggleFocusMode();
				expect(store.state.focusMode).toBe(false);
			});
		});

		it("does not persist focusMode to backend (session-only)", () => {
			testInScope(() => {
				mockInvoke.mockClear();
				store.toggleFocusMode();
				flushPersist();
				const calls = mockInvoke.mock.calls.filter((c) => c[0] === "save_ui_prefs");
				expect(calls).toHaveLength(0);
			});
		});
	});

	describe("fileBrowserExternalRoot", () => {
		it("defaults to null", () => {
			testInScope(() => {
				expect(store.state.fileBrowserExternalRoot).toBeNull();
			});
		});

		it("setFileBrowserExternalRoot stores the given path", () => {
			testInScope(() => {
				store.setFileBrowserExternalRoot("/tmp/foo");
				expect(store.state.fileBrowserExternalRoot).toBe("/tmp/foo");
			});
		});

		it("setFileBrowserExternalRoot(null) clears it", () => {
			testInScope(() => {
				store.setFileBrowserExternalRoot("/tmp/foo");
				store.setFileBrowserExternalRoot(null);
				expect(store.state.fileBrowserExternalRoot).toBeNull();
			});
		});

		it("is ephemeral — does not persist via save_ui_prefs", () => {
			testInScope(() => {
				mockInvoke.mockClear();
				store.setFileBrowserExternalRoot("/tmp/foo");
				flushPersist();
				const persistCalls = mockInvoke.mock.calls.filter((c) => c[0] === "save_ui_prefs");
				expect(persistCalls).toHaveLength(0);
			});
		});
	});

	describe("hydrate()", () => {
		it("loads sidebar state from Rust backend", async () => {
			mockInvoke.mockResolvedValueOnce({ sidebar_visible: false, sidebar_width: 280 });

			await testInScopeAsync(async () => {
				await store.hydrate();
				expect(store.state.sidebarVisible).toBe(false);
				expect(store.state.sidebarWidth).toBe(280);
				expect(mockInvoke).toHaveBeenCalledWith("load_ui_prefs");
			});
		});

		it("migrates from localStorage on first run", async () => {
			localStorage.setItem("tui-commander-sidebar-visible", "false");
			localStorage.setItem("tui-commander-sidebar-width", "350");
			mockInvoke.mockResolvedValueOnce(undefined); // save_ui_prefs migration
			mockInvoke.mockResolvedValueOnce({ sidebar_visible: false, sidebar_width: 350 }); // load_ui_prefs

			await testInScopeAsync(async () => {
				await store.hydrate();
				expect(localStorage.getItem("tui-commander-sidebar-visible")).toBeNull();
				expect(localStorage.getItem("tui-commander-sidebar-width")).toBeNull();
			});
		});

		it("keeps defaults on invoke failure", async () => {
			mockInvoke.mockRejectedValueOnce(new Error("no backend"));

			await testInScopeAsync(async () => {
				await store.hydrate();
				expect(store.state.sidebarVisible).toBe(true);
				expect(store.state.sidebarWidth).toBe(300);
			});
		});

		it("migrates only sidebar-visible from localStorage", async () => {
			localStorage.setItem("tui-commander-sidebar-visible", "true");
			// No width key set
			mockInvoke.mockResolvedValueOnce(undefined); // save_ui_prefs migration
			mockInvoke.mockResolvedValueOnce({ sidebar_visible: true, sidebar_width: 300 }); // load_ui_prefs

			await testInScopeAsync(async () => {
				await store.hydrate();
				expect(localStorage.getItem("tui-commander-sidebar-visible")).toBeNull();
			});
		});

		it("clamps NaN width during migration", async () => {
			localStorage.setItem("tui-commander-sidebar-width", "not-a-number");
			mockInvoke.mockResolvedValueOnce(undefined); // save_ui_prefs
			mockInvoke.mockResolvedValueOnce({ sidebar_width: 300 }); // load_ui_prefs

			await testInScopeAsync(async () => {
				await store.hydrate();
				expect(localStorage.getItem("tui-commander-sidebar-width")).toBeNull();
				// Should have used default 300 since NaN was parsed
				expect(mockInvoke).toHaveBeenCalledWith("save_ui_prefs", {
					config: expect.objectContaining({ sidebar_width: 300 }),
				});
			});
		});

		it("handles null from load_ui_prefs", async () => {
			mockInvoke.mockResolvedValueOnce(null);

			await testInScopeAsync(async () => {
				await store.hydrate();
				// Should keep defaults
				expect(store.state.sidebarVisible).toBe(true);
				expect(store.state.sidebarWidth).toBe(300);
			});
		});

		it("handles partial loaded data (only visible)", async () => {
			mockInvoke.mockResolvedValueOnce({ sidebar_visible: false });

			await testInScopeAsync(async () => {
				await store.hydrate();
				expect(store.state.sidebarVisible).toBe(false);
				expect(store.state.sidebarWidth).toBe(300); // unchanged
			});
		});

		it("handles partial loaded data (only width)", async () => {
			mockInvoke.mockResolvedValueOnce({ sidebar_width: 400 });

			await testInScopeAsync(async () => {
				await store.hydrate();
				expect(store.state.sidebarVisible).toBe(true); // unchanged
				expect(store.state.sidebarWidth).toBe(400);
			});
		});
	});

	describe("sidebar width", () => {
		it("defaults to 300", () => {
			testInScope(() => {
				expect(store.state.sidebarWidth).toBe(300);
			});
		});

		it("setSidebarWidth updates width", () => {
			testInScope(() => {
				store.setSidebarWidth(250);
				expect(store.state.sidebarWidth).toBe(250);
			});
		});

		it("setSidebarWidth clamps to min/max", () => {
			testInScope(() => {
				store.setSidebarWidth(100);
				expect(store.state.sidebarWidth).toBe(200);
				store.setSidebarWidth(600);
				expect(store.state.sidebarWidth).toBe(500);
			});
		});

		it("persists sidebar width via invoke", () => {
			testInScope(() => {
				store.setSidebarWidth(350);
				flushPersist();
				expect(mockInvoke).toHaveBeenCalledWith("save_ui_prefs", {
					config: expect.objectContaining({ sidebar_width: 350 }),
				});
			});
		});
	});

	describe("markdown panel", () => {
		it("opening it logs nothing — no leftover debug instrumentation", async () => {
			const { appLogger } = await import("../../stores/appLogger");
			const warn = vi.spyOn(appLogger, "warn");

			testInScope(() => {
				store.setMarkdownPanelVisible(true);
			});

			expect(warn).not.toHaveBeenCalled();
		});

		it("hydrating with the panel open logs nothing", async () => {
			const { appLogger } = await import("../../stores/appLogger");
			const warn = vi.spyOn(appLogger, "warn");
			mockInvoke.mockResolvedValueOnce({ markdown_panel_visible: true });

			await testInScopeAsync(async () => {
				await store.hydrate();
				expect(store.state.markdownPanelVisible).toBe(true);
			});

			expect(warn).not.toHaveBeenCalled();
		});

		it("toggleMarkdownPanel toggles", () => {
			testInScope(() => {
				store.toggleMarkdownPanel();
				expect(store.state.markdownPanelVisible).toBe(true);
			});
		});

		it("setMarkdownPanelVisible sets directly", () => {
			testInScope(() => {
				store.setMarkdownPanelVisible(true);
				expect(store.state.markdownPanelVisible).toBe(true);
			});
		});
	});

	describe("dropdowns", () => {
		it("toggleIdeDropdown sets activeDropdown to ide", () => {
			testInScope(() => {
				store.toggleIdeDropdown();
				expect(store.state.activeDropdown).toBe("ide");
			});
		});

		it("toggleFontDropdown replaces active dropdown", () => {
			testInScope(() => {
				store.toggleIdeDropdown();
				store.toggleFontDropdown();
				expect(store.state.activeDropdown).toBe("font");
			});
		});

		it("toggleAgentDropdown sets activeDropdown to agent", () => {
			testInScope(() => {
				store.toggleAgentDropdown();
				expect(store.state.activeDropdown).toBe("agent");
			});
		});

		it("toggling the same dropdown again closes it", () => {
			testInScope(() => {
				store.toggleIdeDropdown();
				store.toggleIdeDropdown();
				expect(store.state.activeDropdown).toBeNull();
			});
		});

		it("closeAllDropdowns sets activeDropdown to null", () => {
			testInScope(() => {
				store.toggleIdeDropdown();
				store.closeAllDropdowns();
				expect(store.state.activeDropdown).toBeNull();
			});
		});
	});

	describe("panel widths", () => {
		it("defaults to expected widths", () => {
			testInScope(() => {
				expect(store.state.settingsNavWidth).toBe(180);
			});
		});

		it("setSettingsNavWidth updates state without persisting (persist on drag-end)", () => {
			testInScope(() => {
				store.setSettingsNavWidth(220);
				expect(store.state.settingsNavWidth).toBe(220);
				// setSettingsNavWidth no longer calls save_ui_prefs directly (IPC storm fix);
				// callers must call persistUIPrefs() explicitly after drag-end
			});
		});

		it("persistUIPrefs saves current state to backend", () => {
			testInScope(() => {
				store.setSettingsNavWidth(220);
				mockInvoke.mockClear();
				store.persistUIPrefs();
				flushPersist();
				expect(mockInvoke).toHaveBeenCalledWith("save_ui_prefs", {
					config: expect.objectContaining({ settings_nav_width: 220 }),
				});
			});
		});

		it("hydrate loads panel widths from backend", async () => {
			mockInvoke.mockResolvedValueOnce({
				sidebar_visible: true,
				sidebar_width: 300,
				settings_nav_width: 200,
			});

			await testInScopeAsync(async () => {
				await store.hydrate();
				expect(store.state.settingsNavWidth).toBe(200);
			});
		});

		it("hydrate keeps panel width defaults when not in loaded data", async () => {
			mockInvoke.mockResolvedValueOnce({ sidebar_visible: true });

			await testInScopeAsync(async () => {
				await store.hydrate();
				expect(store.state.settingsNavWidth).toBe(180);
			});
		});

		it("save_ui_prefs includes the tracked panel widths", () => {
			testInScope(() => {
				store.setSidebarWidth(300);
				flushPersist();
				expect(mockInvoke).toHaveBeenCalledWith("save_ui_prefs", {
					config: expect.objectContaining({
						sidebar_visible: true,
						sidebar_width: 300,
						settings_nav_width: 180,
					}),
				});
			});
		});
	});

	describe("AI Chat panel", () => {
		it("defaults to hidden", () => {
			testInScope(() => {
				expect(store.state.aiChatPanelVisible).toBe(false);
			});
		});

		it("toggleAiChatPanel toggles visibility", () => {
			testInScope(() => {
				store.toggleAiChatPanel();
				expect(store.state.aiChatPanelVisible).toBe(true);
				store.toggleAiChatPanel();
				expect(store.state.aiChatPanelVisible).toBe(false);
			});
		});

		it("setAiChatPanelVisible sets directly", () => {
			testInScope(() => {
				store.setAiChatPanelVisible(true);
				expect(store.state.aiChatPanelVisible).toBe(true);
			});
		});

		it("opening AI Chat closes other exclusive panels", () => {
			testInScope(() => {
				store.toggleMarkdownPanel();
				expect(store.state.markdownPanelVisible).toBe(true);
				store.toggleAiChatPanel();
				expect(store.state.aiChatPanelVisible).toBe(true);
				expect(store.state.markdownPanelVisible).toBe(false);
			});
		});

		it("opening another exclusive panel closes AI Chat", () => {
			testInScope(() => {
				store.toggleAiChatPanel();
				expect(store.state.aiChatPanelVisible).toBe(true);
				store.toggleGitPanel();
				expect(store.state.gitPanelVisible).toBe(true);
				expect(store.state.aiChatPanelVisible).toBe(false);
			});
		});
	});

	describe("detachedPanels", () => {
		it("setDetached adds entry to map", () => {
			testInScope(() => {
				store.setDetached("activity", "panel-activity");
				expect(store.state.detachedPanels).toEqual({ activity: "panel-activity" });
			});
		});

		it("setDetached supports multiple panels", () => {
			testInScope(() => {
				store.setDetached("activity", "panel-activity");
				store.setDetached("ai-chat", "panel-ai-chat");
				expect(store.state.detachedPanels).toEqual({
					activity: "panel-activity",
					"ai-chat": "panel-ai-chat",
				});
			});
		});

		it("clearDetached removes the entry", () => {
			testInScope(() => {
				store.setDetached("activity", "panel-activity");
				store.setDetached("ai-chat", "panel-ai-chat");
				store.clearDetached("activity");
				expect(store.state.detachedPanels).toEqual({ "ai-chat": "panel-ai-chat" });
			});
		});

		it("clearDetached is no-op for non-existent panel", () => {
			testInScope(() => {
				store.clearDetached("nonexistent");
				expect(store.state.detachedPanels).toEqual({});
			});
		});

		it("isDetached returns correct boolean", () => {
			testInScope(() => {
				expect(store.isDetached("activity")).toBe(false);
				store.setDetached("activity", "panel-activity");
				expect(store.isDetached("activity")).toBe(true);
				store.clearDetached("activity");
				expect(store.isDetached("activity")).toBe(false);
			});
		});

		it("persists via save_ui_prefs on setDetached", () => {
			testInScope(() => {
				mockInvoke.mockClear();
				store.setDetached("activity", "panel-activity");
				flushPersist();
				const persistCalls = mockInvoke.mock.calls.filter((c) => c[0] === "save_ui_prefs");
				expect(persistCalls).toHaveLength(1);
				expect(persistCalls[0][1].config.detached_panels).toEqual({ activity: "panel-activity" });
			});
		});

		it("persists via save_ui_prefs on clearDetached", () => {
			testInScope(() => {
				store.setDetached("activity", "panel-activity");
				mockInvoke.mockClear();
				store.clearDetached("activity");
				flushPersist();
				const persistCalls = mockInvoke.mock.calls.filter((c) => c[0] === "save_ui_prefs");
				expect(persistCalls).toHaveLength(1);
				expect(persistCalls[0][1].config.detached_panels).toEqual({});
			});
		});
	});

	describe("githubSectionCollapsed", () => {
		it("reports undefined for a section nobody has toggled", () => {
			testInScope(() => {
				expect(store.getGithubSectionCollapsed("issues")).toBeUndefined();
			});
		});

		it("stores the collapsed flag per section id", () => {
			testInScope(() => {
				store.setGithubSectionCollapsed("issues", true);
				store.setGithubSectionCollapsed("prs", false);
				expect(store.getGithubSectionCollapsed("issues")).toBe(true);
				expect(store.getGithubSectionCollapsed("prs")).toBe(false);
			});
		});

		it("persists to the backend so the state survives a restart", () => {
			testInScope(() => {
				store.setGithubSectionCollapsed("issues", true);
				flushPersist();
				expect(mockInvoke).toHaveBeenCalledWith("save_ui_prefs", {
					config: expect.objectContaining({ github_section_collapsed: { issues: true } }),
				});
			});
		});

		it("hydrates the map from the backend", async () => {
			mockInvoke.mockResolvedValueOnce({ github_section_collapsed: { issues: true, "my-prs": false } });

			await testInScopeAsync(async () => {
				await store.hydrate();
				expect(store.getGithubSectionCollapsed("issues")).toBe(true);
				expect(store.getGithubSectionCollapsed("my-prs")).toBe(false);
				expect(store.getGithubSectionCollapsed("prs")).toBeUndefined();
			});
		});
	});

	describe("dead right-panel width state", () => {
		// PanelResizeHandle sets panel.style.width inline and never tells the
		// store, so these four fields had no writer and no reader — they were
		// serialized on every persist for nothing.
		it("does not serialize the unread right-panel widths", () => {
			testInScope(() => {
				mockInvoke.mockClear();
				store.toggleSidebar();
				flushPersist();

				const config = mockInvoke.mock.calls.filter((c) => c[0] === "save_ui_prefs")[0][1].config;
				expect(config).not.toHaveProperty("markdown_panel_width");
				expect(config).not.toHaveProperty("notes_panel_width");
				expect(config).not.toHaveProperty("git_panel_width");
				expect(config).not.toHaveProperty("ai_chat_panel_width");
				// The widths that do have readers stay.
				expect(config).toHaveProperty("sidebar_width");
				expect(config).toHaveProperty("settings_nav_width");
			});
		});

		it("exposes no setters for them", () => {
			const store_ = store as unknown as Record<string, unknown>;
			expect(store_.setMarkdownPanelWidth).toBeUndefined();
			expect(store_.setNotesPanelWidth).toBeUndefined();
			expect(store_.setGitPanelWidth).toBeUndefined();
			expect(store_.setAiChatPanelWidth).toBeUndefined();
		});
	});

	describe("persistence debounce", () => {
		it("coalesces a burst of mutations into a single save_ui_prefs", () => {
			testInScope(() => {
				mockInvoke.mockClear();

				store.toggleSidebar();
				store.toggleGitPanel();
				store.toggleNotesPanel();

				expect(mockInvoke.mock.calls.filter((c) => c[0] === "save_ui_prefs")).toHaveLength(0);

				flushPersist();

				const calls = mockInvoke.mock.calls.filter((c) => c[0] === "save_ui_prefs");
				expect(calls).toHaveLength(1);
				// The single write carries the final state, not the first mutation's.
				expect(calls[0][1].config).toMatchObject({
					sidebar_visible: false,
					notes_panel_visible: true,
					git_panel_visible: false,
				});
			});
		});
	});

	describe("loading state", () => {
		it("setLoading sets loading and message", () => {
			testInScope(() => {
				store.setLoading(true, "Loading...");
				expect(store.state.isLoading).toBe(true);
				expect(store.state.loadingMessage).toBe("Loading...");
			});
		});

		it("setLoading clears message when no message provided", () => {
			testInScope(() => {
				store.setLoading(true, "Loading...");
				store.setLoading(false);
				expect(store.state.isLoading).toBe(false);
				expect(store.state.loadingMessage).toBe("");
			});
		});
	});
});
