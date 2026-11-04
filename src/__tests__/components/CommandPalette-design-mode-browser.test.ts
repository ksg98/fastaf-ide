import { createRoot } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";

const { mockTerminals } = vi.hoisted(() => ({
	mockTerminals: {
		state: { activeId: "term-1" as string | null },
		get: vi.fn(() => ({ sessionId: "session-1", agentType: "claude" })),
		findTerminalWithSession: vi.fn(() => ({ sessionId: "session-1", agentType: "claude" })),
	},
}));

vi.mock("../../actions/actionRegistry", () => ({ getActionEntries: () => [] }));
vi.mock("../../stores/appLogger", () => ({ appLogger: { error: vi.fn(), warn: vi.fn() } }));
vi.mock("../../stores/commandPalette", () => ({ commandPaletteStore: { openWithQuery: vi.fn() } }));
vi.mock("../../stores/contextMenuActionsStore", () => ({ contextMenuActionsStore: { getActions: () => [] } }));
vi.mock("../../stores/pluginStore", () => ({
	pluginStore: { state: { plugins: [] }, getPlugin: vi.fn(), setEnabled: vi.fn() },
}));
vi.mock("../../stores/promptLibrary", () => ({ promptLibraryStore: { getSmartByPlacement: () => [] } }));
vi.mock("../../stores/repositories", () => ({
	repositoriesStore: {
		state: { repositories: {}, groups: {}, namedWorkspaces: {}, namedWorkspaceOrder: [] },
		setActive: vi.fn(),
		setPark: vi.fn(),
		isGroupFullyParked: vi.fn(() => false),
		setParkGroup: vi.fn(),
	},
}));
vi.mock("../../stores/terminals", () => ({ terminalsStore: mockTerminals }));
vi.mock("../../invoke", () => ({
	invoke: vi.fn().mockResolvedValue(undefined),
	listen: vi.fn().mockResolvedValue(vi.fn()),
}));
vi.mock("../../stores/updater", () => ({ updaterStore: { checkForUpdate: vi.fn() } }));

import { isBrowserCommandPaletteAction } from "../../components/CommandPalette/CommandPalette";
import { useCommandPaletteActions } from "../../hooks/useCommandPaletteActions";

describe("Design Mode in the browser-mode command palette", () => {
	let dispose: (() => void) | undefined;
	afterEach(() => dispose?.());

	it("still offers a Design Mode start to a browser or PWA client", () => {
		// Catches: renaming the palette start entries without updating the browser
		// allowlist, so a phone/browser client loses its only palette Design Mode start.
		let actions: ReturnType<typeof useCommandPaletteActions> | undefined;
		createRoot((rootDispose) => {
			dispose = rootDispose;
			actions = useCommandPaletteActions({
				shortcutHandlers: {} as never,
				gitOps: { getWorktreeTargets: vi.fn(() => []) } as never,
				splitPanes: { resetLayout: vi.fn() } as never,
				executeSmartPrompt: vi.fn().mockResolvedValue(undefined),
			});
		});
		const browserStarts = (actions?.() ?? [])
			.filter(isBrowserCommandPaletteAction)
			.filter((entry) => /^Start Design Mode/.test(entry.label));
		expect(browserStarts.length).toBeGreaterThan(0);
	});
});
