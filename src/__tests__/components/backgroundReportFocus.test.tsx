import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const { transport } = vi.hoisted(() => ({
	transport: {
		sink: null as ((data: ArrayBuffer) => void) | null,
		invoke: vi.fn(),
	},
}));
vi.mock("../../components/Terminal/canvasTerminalTransport", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../components/Terminal/canvasTerminalTransport")>()),
	createTransport: () => ({
		onEvent: vi.fn().mockResolvedValue(undefined),
		onStreamError: vi.fn(),
		subscribe: async (sink: (data: ArrayBuffer) => void) => {
			transport.sink = sink;
		},
		resubscribe: vi.fn().mockResolvedValue(undefined),
		unsubscribe: vi.fn(),
		ackFrame: vi.fn(),
		invoke: transport.invoke,
	}),
}));

import { listen } from "@tauri-apps/api/event";
import CanvasTerminal from "../../components/Terminal/CanvasTerminal";
import { TerminalArea } from "../../components/TerminalArea";
import { type AppInitDeps, initApp } from "../../hooks/useAppInit";
import { mdTabsStore } from "../../stores/mdTabs";
import { paneLayoutStore } from "../../stores/paneLayout";
import { repositoriesStore } from "../../stores/repositories";
import { terminalsStore } from "../../stores/terminals";
import { makeTerminal } from "../helpers/store";

// Keep the real terminal hidden input and TerminalArea's production blur effect.
// Only the surrounding terminal lifecycle and renderer ports are substituted.
vi.mock("../../components/Terminal", () => ({
	Terminal: (props: { id: string }) => <CanvasTerminal sessionId="typing-session" terminalId={props.id} />,
}));
vi.mock("../../components/shared/MdTabContent", () => ({ MdTabContent: () => <div>Report</div> }));
vi.mock("../../hooks/useFileDrop", () => ({ useFileDrop: () => ({ isDragging: () => false, attachTo: () => {} }) }));

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
	transport.sink = null;
	transport.invoke.mockReset().mockResolvedValue(undefined);
	for (const id of mdTabsStore.getIds()) mdTabsStore.remove(id);
	for (const id of terminalsStore.getIds()) terminalsStore.remove(id);
	for (const path of repositoriesStore.getPaths()) repositoriesStore.remove(path);
	Object.defineProperty(document, "fonts", {
		configurable: true,
		value: { load: async () => [], ready: Promise.resolve() },
	});
	vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
		width: 800,
		height: 400,
		top: 0,
		left: 0,
		right: 800,
		bottom: 400,
		x: 0,
		y: 0,
		toJSON: () => ({}),
	});
	const context = new Proxy(
		{ measureText: () => ({ width: 8, fontBoundingBoxAscent: 10, fontBoundingBoxDescent: 3 }) },
		{ get: (target, key) => target[key as keyof typeof target] ?? (() => {}) },
	);
	vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as unknown as CanvasRenderingContext2D);
	vi.stubGlobal(
		"ResizeObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
	vi.stubGlobal(
		"IntersectionObserver",
		class {
			observe() {}
			disconnect() {}
		},
	);
});
afterEach(() => {
	cleanup();
	vi.useRealTimers();
	repositoriesStore._testCancelPendingSave();
	paneLayoutStore._testCancelPendingSave();
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
});

it("background_report_open_and_update_preserve_terminal_input_focus — catches: default report delivery blurs the typing terminal", async () => {
	let send:
		| ((event: {
				payload: {
					id: string;
					title: string;
					html: string;
					pinned: boolean;
					focus?: boolean;
					origin_repo_path?: string;
				};
		  }) => void)
		| undefined;
	vi.mocked(listen).mockImplementation(((event: string, handler: typeof send) => {
		if (event === "ui-tab") send = handler;
		return Promise.resolve(vi.fn());
	}) as unknown as typeof listen);
	const noop = vi.fn();
	await initApp({
		pty: { listActiveSessions: vi.fn().mockResolvedValue([]), close: vi.fn().mockResolvedValue(undefined) },
		setStatusInfo: noop,
		handleBranchSelect: vi.fn().mockResolvedValue(undefined),
		refreshAllBranchStats: noop,
		getDefaultFontSize: () => 14,
		stores: {
			hydrate: vi.fn().mockResolvedValue(undefined),
			startPolling: noop,
			stopPolling: noop,
			startAutoFetch: noop,
			startPrNotificationTimer: noop,
			loadFontFromConfig: noop,
			startDictationSettingsSync: vi.fn(() => vi.fn()),
			refreshDictationConfig: vi.fn().mockResolvedValue(undefined),
			startUserActivityListening: noop,
		},
		applyPlatformClass: () => "macos",
		registerRepo: vi.fn().mockResolvedValue(undefined),
	} satisfies AppInitDeps);
	repositoriesStore.add({ path: "/repo/typing", displayName: "typing" });
	repositoriesStore.add({ path: "/repo/report", displayName: "report" });
	repositoriesStore.setActive("/repo/typing");
	const terminalId = terminalsStore.add(makeTerminal({ sessionId: "typing-session" }));
	terminalsStore.setActive(terminalId);
	const view = render(() => (
		<TerminalArea onTerminalFocus={noop} onCloseTab={noop} onOpenFilePath={noop} onContextMenu={noop} />
	));
	await waitFor(() => expect(transport.sink).not.toBeNull());
	const input = view.container.querySelector<HTMLInputElement>('input[aria-hidden="true"]')!;
	expect(input).not.toBeNull();
	input.focus();
	expect(document.activeElement).toBe(input);
	const report = {
		id: "background-report",
		title: "Report",
		html: "<p>Report</p>",
		pinned: false,
		origin_repo_path: "/repo/report",
	};
	for (const [i, character] of [..."typing"].entries()) {
		send!({ payload: { ...report, id: i < 3 ? `report-${i}` : "report-0", html: `<p>${i}</p>` } });
		// Observe DOM focus, not merely the selected-tab label, before typing.
		expect(document.activeElement).toBe(input);
		expect(repositoriesStore.state.activeRepoPath).toBe("/repo/typing");
		expect(terminalsStore.state.activeId).toBe(terminalId);
		document.activeElement!.dispatchEvent(
			new InputEvent("input", { data: character, inputType: "insertText", bubbles: true }),
		);
	}
	expect(
		transport.invoke.mock.calls
			.filter(([cmd]) => cmd === "write_pty")
			.map(([, args]) => args.data)
			.join(""),
	).toBe("typing");
	expect(mdTabsStore.getIds()).toHaveLength(3);
	// Explicit focused opens navigate; subsequent updates never navigate.
	send!({ payload: { ...report, id: "explicit-report", focus: true } });
	expect(repositoriesStore.state.activeRepoPath).toBe("/repo/report");
	expect(document.activeElement).not.toBe(input);
	mdTabsStore.setActive(null);
	terminalsStore.setActive(terminalId);
	repositoriesStore.setActive("/repo/typing");
	input.focus();
	send!({ payload: { ...report, id: "explicit-report", focus: true, html: "<p>Updated</p>" } });
	expect(document.activeElement).toBe(input);
	expect(repositoriesStore.state.activeRepoPath).toBe("/repo/typing");
});
