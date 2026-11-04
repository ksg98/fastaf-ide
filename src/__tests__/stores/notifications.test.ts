import { beforeEach, describe, expect, it, vi } from "vitest";
import { testInScope, testInScopeAsync } from "../helpers/store";

const mockInvoke = vi.fn().mockResolvedValue(undefined);
const mockSetBadgeCount = vi.fn().mockResolvedValue(undefined);
const nativeSend = vi.fn();
// Hoisted so the terminals module is mocked before any import, whatever the load or test order.
const terminalsState = vi.hoisted(() => ({ activeId: "" }));

vi.mock("../../stores/terminals", () => ({
	terminalsStore: {
		get: () => ({ name: "Deploy Agent" }),
		state: {
			get activeId() {
				return terminalsState.activeId;
			},
		},
		isDetached: () => false,
	},
}));

vi.mock("@tauri-apps/plugin-notification", () => ({
	isPermissionGranted: vi.fn().mockResolvedValue(true),
	requestPermission: vi.fn().mockResolvedValue("granted"),
	sendNotification: nativeSend,
}));

vi.mock("@tauri-apps/api/core", () => ({
	invoke: mockInvoke,
}));

vi.mock("@tauri-apps/api/window", () => ({
	getCurrentWindow: () => ({
		setBadgeCount: mockSetBadgeCount,
	}),
}));

// Mock the notificationManager before importing the store
vi.mock("../../notifications", () => ({
	notificationManager: {
		play: vi.fn().mockResolvedValue(undefined),
		playQuestion: vi.fn().mockResolvedValue(undefined),
		playError: vi.fn().mockResolvedValue(undefined),
		playCompletion: vi.fn().mockResolvedValue(undefined),
		playWarning: vi.fn().mockResolvedValue(undefined),
		playInfo: vi.fn().mockResolvedValue(undefined),
		updateConfig: vi.fn(),
		setEnabled: vi.fn(),
		setVolume: vi.fn(),
		setSoundEnabled: vi.fn(),
		isAvailable: vi.fn().mockReturnValue(true),
		getConfig: vi.fn().mockReturnValue({
			enabled: true,
			volume: 0.5,
			sounds: { question: true, error: true, completion: true, warning: true, info: true },
		}),
	},
	DEFAULT_NOTIFICATION_CONFIG: {
		enabled: true,
		volume: 0.5,
		sounds: { question: true, error: true, completion: true, warning: true, info: true },
	},
}));

describe("notificationsStore", () => {
	let store: typeof import("../../stores/notifications").notificationsStore;
	let mockManager: {
		play: ReturnType<typeof vi.fn>;
		playQuestion: ReturnType<typeof vi.fn>;
		playError: ReturnType<typeof vi.fn>;
		playCompletion: ReturnType<typeof vi.fn>;
		playWarning: ReturnType<typeof vi.fn>;
		playInfo: ReturnType<typeof vi.fn>;
		updateConfig: ReturnType<typeof vi.fn>;
		setEnabled: ReturnType<typeof vi.fn>;
		setVolume: ReturnType<typeof vi.fn>;
		setSoundEnabled: ReturnType<typeof vi.fn>;
		isAvailable: ReturnType<typeof vi.fn>;
		getConfig: ReturnType<typeof vi.fn>;
	};

	beforeEach(async () => {
		vi.resetModules();
		mockInvoke.mockReset().mockResolvedValue(undefined);
		mockSetBadgeCount.mockReset().mockResolvedValue(undefined);
		nativeSend.mockReset();
		localStorage.clear();

		vi.doMock("@tauri-apps/api/core", () => ({
			invoke: mockInvoke,
		}));

		vi.doMock("@tauri-apps/api/window", () => ({
			getCurrentWindow: () => ({
				setBadgeCount: mockSetBadgeCount,
			}),
		}));

		// Re-mock after resetModules
		vi.doMock("../../notifications", () => ({
			notificationManager: {
				play: vi.fn().mockResolvedValue(undefined),
				playQuestion: vi.fn().mockResolvedValue(undefined),
				playError: vi.fn().mockResolvedValue(undefined),
				playCompletion: vi.fn().mockResolvedValue(undefined),
				playWarning: vi.fn().mockResolvedValue(undefined),
				updateConfig: vi.fn(),
				setEnabled: vi.fn(),
				setVolume: vi.fn(),
				setSoundEnabled: vi.fn(),
				isAvailable: vi.fn().mockReturnValue(true),
				getConfig: vi.fn().mockReturnValue({
					enabled: true,
					volume: 0.5,
					sounds: { question: true, error: true, completion: true, warning: true },
				}),
			},
			DEFAULT_NOTIFICATION_CONFIG: {
				enabled: true,
				volume: 0.5,
				sounds: { question: true, error: true, completion: true, warning: true },
			},
		}));

		const notifMod = await import("../../notifications");
		mockManager = notifMod.notificationManager as unknown as typeof mockManager;
		store = (await import("../../stores/notifications")).notificationsStore;
		await store.hydrate();
		mockInvoke.mockClear();
	});

	describe("defaults", () => {
		it("has correct defaults", () => {
			testInScope(() => {
				expect(store.state.config.enabled).toBe(true);
				expect(store.state.config.volume).toBe(0.5);
				expect(store.state.config.sounds.question).toBe(true);
				expect(store.state.config.sounds.error).toBe(true);
				expect(store.state.config.sounds.completion).toBe(true);
				expect(store.state.config.sounds.warning).toBe(true);
			});
		});
	});

	// Catches: opting out is lost on reload, or the missing preference unexpectedly defaults off.
	it("persists automatic card opt-out across store reloads and resets to on", async () => {
		expect(store.state.autoToastCards).toBe(true);
		store.setAutoToastCards(false);
		vi.resetModules();
		const reloaded = (await import("../../stores/notifications")).notificationsStore;
		expect(reloaded.state.autoToastCards).toBe(false);
		reloaded.reset();
		vi.resetModules();
		expect((await import("../../stores/notifications")).notificationsStore.state.autoToastCards).toBe(true);
	});

	describe("ACP interaction notifications", () => {
		async function withUnfocusedDesktop(run: () => Promise<void>) {
			vi.stubGlobal("__TAURI_INTERNALS__", {});
			// WKWebView answers denied at once; the native notifier must not depend on it.
			vi.stubGlobal("Notification", { permission: "denied", requestPermission: vi.fn().mockResolvedValue("denied") });
			const focus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
			try {
				await run();
			} finally {
				focus.mockRestore();
				vi.unstubAllGlobals();
			}
		}

		it("uses the native notifier even when the WebView Notification permission is denied", async () => {
			await withUnfocusedDesktop(async () => {
				store.syncAcpAttention([{ id: "connection-1:permission-1", kind: "permission" }]);
				await vi.waitFor(() =>
					expect(nativeSend).toHaveBeenCalledWith({ title: "AI Chat needs input", body: "Permission requested" }),
				);
			});
		});

		it("notifies once per interaction, including after an unrelated refresh", async () => {
			await withUnfocusedDesktop(async () => {
				const pending = [{ id: "connection-1:permission-1", kind: "permission" as const }];
				store.syncAcpAttention(pending);
				store.syncAcpAttention([...pending]);
				await vi.waitFor(() => expect(nativeSend).toHaveBeenCalledTimes(1));
				store.syncAcpAttention([...pending, { id: "connection-1:form-1", kind: "elicitation" }]);
				await vi.waitFor(() => expect(nativeSend).toHaveBeenCalledTimes(2));
				expect(nativeSend).toHaveBeenLastCalledWith({ title: "AI Chat needs input", body: "Form requested" });
			});
		});

		it("does not notify after the interaction is answered while native permission is pending", async () => {
			await withUnfocusedDesktop(async () => {
				store.syncAcpAttention([{ id: "connection-1:permission-1", kind: "permission" }]);
				store.syncAcpAttention([]);
				await new Promise((resolve) => setTimeout(resolve, 0));
				expect(nativeSend).not.toHaveBeenCalled();
			});
		});

		it("does not notify while the window is focused", async () => {
			vi.stubGlobal("__TAURI_INTERNALS__", {});
			const focus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
			try {
				store.syncAcpAttention([{ id: "connection-1:permission-1", kind: "permission" }]);
				await new Promise((resolve) => setTimeout(resolve, 0));
				expect(nativeSend).not.toHaveBeenCalled();
			} finally {
				focus.mockRestore();
				vi.unstubAllGlobals();
			}
		});
	});

	describe("setEnabled()", () => {
		it("enables/disables notifications", () => {
			testInScope(() => {
				store.setEnabled(false);
				expect(store.state.config.enabled).toBe(false);
				expect(store.isEnabled()).toBe(false);
			});
		});

		it("persists via Tauri invoke", () => {
			testInScope(() => {
				store.setEnabled(false);
				expect(mockInvoke).toHaveBeenCalledWith(
					"save_notification_config",
					expect.objectContaining({ config: expect.objectContaining({ enabled: false }) }),
				);
			});
		});
	});

	describe("setVolume()", () => {
		it("sets volume", () => {
			testInScope(() => {
				store.setVolume(0.8);
				expect(store.state.config.volume).toBe(0.8);
			});
		});

		it("clamps volume to valid range", () => {
			testInScope(() => {
				store.setVolume(2);
				expect(store.state.config.volume).toBe(1);
				store.setVolume(-0.5);
				expect(store.state.config.volume).toBe(0);
			});
		});
	});

	describe("setSoundEnabled()", () => {
		it("enables/disables specific sound", () => {
			testInScope(() => {
				store.setSoundEnabled("question", false);
				expect(store.state.config.sounds.question).toBe(false);
			});
		});
	});

	describe("isEnabled()", () => {
		it("returns enabled state", () => {
			testInScope(() => {
				expect(store.isEnabled()).toBe(true);
				store.setEnabled(false);
				expect(store.isEnabled()).toBe(false);
			});
		});
	});

	describe("isSoundEnabled()", () => {
		it("checks both global and per-sound enabled", () => {
			testInScope(() => {
				expect(store.isSoundEnabled("question")).toBe(true);

				store.setSoundEnabled("question", false);
				expect(store.isSoundEnabled("question")).toBe(false);

				store.setSoundEnabled("question", true);
				store.setEnabled(false);
				expect(store.isSoundEnabled("question")).toBe(false);
			});
		});
	});

	describe("reset()", () => {
		it("resets to defaults", () => {
			testInScope(() => {
				store.setEnabled(false);
				store.setVolume(0.1);
				store.setSoundEnabled("question", false);
				store.reset();
				expect(store.state.config.enabled).toBe(true);
				expect(store.state.config.volume).toBe(0.5);
				expect(store.state.config.sounds.question).toBe(true);
			});
		});
	});

	describe("hydrate()", () => {
		it("loads config from Tauri backend", async () => {
			mockInvoke.mockImplementation((cmd: string) => {
				if (cmd === "load_notification_config") {
					return Promise.resolve({
						enabled: false,
						volume: 0.3,
						sounds: { question: false, error: true, completion: true, warning: true },
					});
				}
				return Promise.resolve(undefined);
			});

			await testInScopeAsync(async () => {
				await store.hydrate();
				expect(store.state.config.enabled).toBe(false);
				expect(store.state.config.volume).toBe(0.3);
				expect(store.state.config.sounds.question).toBe(false);
			});
		});

		it("migrates from localStorage on first run", async () => {
			localStorage.setItem(
				"tui-commander-notifications",
				JSON.stringify({
					enabled: false,
					volume: 0.7,
					sounds: { question: false, error: true, completion: true, warning: true },
				}),
			);

			mockInvoke.mockImplementation((cmd: string) => {
				if (cmd === "load_notification_config") {
					return Promise.resolve({
						enabled: false,
						volume: 0.7,
						sounds: { question: false, error: true, completion: true, warning: true },
					});
				}
				return Promise.resolve(undefined);
			});

			await testInScopeAsync(async () => {
				await store.hydrate();
				// Should have saved legacy data to Tauri
				expect(mockInvoke).toHaveBeenCalledWith(
					"save_notification_config",
					expect.objectContaining({ config: expect.objectContaining({ volume: 0.7 }) }),
				);
				// Should have removed legacy key
				expect(localStorage.getItem("tui-commander-notifications")).toBeNull();
			});
		});

		it("handles corrupt localStorage data gracefully", async () => {
			localStorage.setItem("tui-commander-notifications", "not-json{{{");

			mockInvoke.mockImplementation((cmd: string) => {
				if (cmd === "load_notification_config") {
					return Promise.resolve({
						enabled: true,
						volume: 0.5,
						sounds: { question: true, error: true, completion: true, warning: true },
					});
				}
				return Promise.resolve(undefined);
			});

			await testInScopeAsync(async () => {
				await store.hydrate();
				// Should have removed corrupt data
				expect(localStorage.getItem("tui-commander-notifications")).toBeNull();
			});
		});

		it("falls back to defaults when Tauri invoke fails", async () => {
			mockInvoke.mockRejectedValue(new Error("invoke failed"));
			const debugSpy = vi.spyOn(console, "debug").mockImplementation(() => {});

			await testInScopeAsync(async () => {
				await store.hydrate();
				expect(store.state.config.enabled).toBe(true);
				expect(store.state.config.volume).toBe(0.5);
			});

			debugSpy.mockRestore();
		});
	});

	describe("play()", () => {
		it("delegates to notificationManager.play()", async () => {
			await store.play("question");
			expect(mockManager.play).toHaveBeenCalledWith("question");
		});

		it("plays error sound", async () => {
			await store.play("error");
			expect(mockManager.play).toHaveBeenCalledWith("error");
		});

		it("plays completion sound", async () => {
			await store.play("completion");
			expect(mockManager.play).toHaveBeenCalledWith("completion");
		});

		it("plays warning sound", async () => {
			await store.play("warning");
			expect(mockManager.play).toHaveBeenCalledWith("warning");
		});
	});

	describe("playQuestion()", () => {
		it("sends a native notification naming the terminal while the window is unfocused", async () => {
			vi.stubGlobal("__TAURI_INTERNALS__", {});
			const focus = vi.spyOn(document, "hasFocus").mockReturnValue(false);
			const oldNotification = window.Notification;
			vi.stubGlobal("Notification", { permission: "denied" });
			try {
				await store.playQuestion("term-1");
				await vi.waitFor(() =>
					expect(nativeSend).toHaveBeenCalledWith({
						title: "Agent needs input",
						body: "Deploy Agent",
					}),
				);
			} finally {
				focus.mockRestore();
				vi.stubGlobal("Notification", oldNotification);
				vi.unstubAllGlobals();
			}
		});

		it("plays question sound via play()", async () => {
			await store.playQuestion();
			expect(mockManager.play).toHaveBeenCalledWith("question");
		});
	});

	describe("playQuestionReminder()", () => {
		async function remind(activeId: string, focused: boolean) {
			vi.stubGlobal("__TAURI_INTERNALS__", {});
			const focus = vi.spyOn(document, "hasFocus").mockReturnValue(focused);
			terminalsState.activeId = activeId;
			try {
				await store.playQuestionReminder("term-1");
				await new Promise((resolve) => setTimeout(resolve, 20));
			} finally {
				focus.mockRestore();
				vi.unstubAllGlobals();
			}
		}

		it("always plays the question sound", async () => {
			await remind("term-1", true);
			expect(mockManager.play).toHaveBeenCalledWith("question");
		});

		// Catches: reminder silent for a question in a background tab of a focused window.
		it("sends the OS notice for a background tab of a focused window", async () => {
			await remind("term-2", true);
			expect(nativeSend).toHaveBeenCalledWith({ title: "Agent needs input", body: "Deploy Agent" });
		});

		// Catches: OS notice popping for a question the user is looking at.
		it("sends no OS notice when the question's tab is active in a focused window", async () => {
			await remind("term-1", true);
			expect(nativeSend).not.toHaveBeenCalled();
		});
	});

	describe("playError()", () => {
		it("plays error sound via play()", async () => {
			await store.playError();
			expect(mockManager.play).toHaveBeenCalledWith("error");
		});
	});

	describe("playCompletion()", () => {
		it("plays completion sound via play()", async () => {
			await store.playCompletion();
			expect(mockManager.play).toHaveBeenCalledWith("completion");
		});
	});

	describe("playWarning()", () => {
		it("plays warning sound via play()", async () => {
			await store.playWarning();
			expect(mockManager.play).toHaveBeenCalledWith("warning");
		});
	});

	describe("playInfo()", () => {
		it("plays info sound via play()", async () => {
			await store.playInfo();
			expect(mockManager.play).toHaveBeenCalledWith("info");
		});
	});

	describe("badge count", () => {
		it("defaults badgeCount to 0", () => {
			testInScope(() => {
				expect(store.state.badgeCount).toBe(0);
			});
		});

		it("incrementBadge increments count and calls setBadgeCount", async () => {
			await testInScopeAsync(async () => {
				await store.incrementBadge();
				expect(store.state.badgeCount).toBe(1);
				expect(mockSetBadgeCount).toHaveBeenCalledWith(1);

				await store.incrementBadge();
				expect(store.state.badgeCount).toBe(2);
				expect(mockSetBadgeCount).toHaveBeenCalledWith(2);
			});
		});

		it("clearBadge resets count and calls setBadgeCount() with no args", async () => {
			await testInScopeAsync(async () => {
				await store.incrementBadge();
				await store.incrementBadge();
				expect(store.state.badgeCount).toBe(2);

				await store.clearBadge();
				expect(store.state.badgeCount).toBe(0);
				expect(mockSetBadgeCount).toHaveBeenCalledWith();
			});
		});

		it("clearBadge is a no-op when count is already 0", async () => {
			await testInScopeAsync(async () => {
				await store.clearBadge();
				expect(mockSetBadgeCount).not.toHaveBeenCalled();
			});
		});
	});

	describe("testSound()", () => {
		it("plays with force, bypassing the rate-limit/enabled gates", async () => {
			await testInScopeAsync(async () => {
				await store.testSound("question");

				expect(mockManager.play).toHaveBeenCalledWith("question", { force: true });
			});
		});

		it("does not mutate enabled/per-sound config (no temporary toggling)", async () => {
			await testInScopeAsync(async () => {
				// Disable notifications and question sound, then clear the setup calls
				store.setEnabled(false);
				store.setSoundEnabled("question", false);
				mockManager.setEnabled.mockClear();
				mockManager.setSoundEnabled.mockClear();

				await store.testSound("question");

				// testSound must not flip config flags — force handles the bypass
				expect(mockManager.setEnabled).not.toHaveBeenCalled();
				expect(mockManager.setSoundEnabled).not.toHaveBeenCalled();
				expect(mockManager.play).toHaveBeenCalledWith("question", { force: true });
			});
		});
	});
});
