import { fireEvent, render } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeMock = vi.hoisted(() => vi.fn());

vi.mock("../../invoke", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../invoke")>();
	return { ...actual, invoke: invokeMock };
});

import type { ActionEntry } from "../../actions/actionRegistry";
import { CommandPalette, isBrowserCommandPaletteAction } from "../../components/CommandPalette/CommandPalette";
import { emitLocalEvent } from "../../invoke";
import { commandPaletteStore } from "../../stores/commandPalette";
import { repositoriesStore } from "../../stores/repositories";
import type { ContentSearchResult, DirEntry } from "../../types/fs";

function setTauriEnv(on: boolean) {
	const global = globalThis as Record<string, unknown>;
	if (on) {
		global.__TAURI_INTERNALS__ = {};
		delete global.__TAURI_SHIM__;
	} else {
		delete global.__TAURI_INTERNALS__;
	}
}

function action(id: string, label: string, execute = vi.fn()): ActionEntry {
	return { id, label, category: "Test", keybinding: "", execute };
}

async function flushPromises(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

const FILE_RESULT: DirEntry = {
	name: "App.tsx",
	path: "src/App.tsx",
	is_dir: false,
	size: 100,
	modified_at: 0,
	git_status: "",
	is_ignored: false,
};

const CONTENT_RESULT: ContentSearchResult = {
	matches: [
		{
			path: "src/App.tsx",
			line_number: 10,
			line_text: "const browserNeedle = true;",
			match_start: 6,
			match_end: 19,
		},
	],
	files_searched: 12,
	files_skipped: 0,
	truncated: false,
	repos_pending: 0,
	repos_searched: 0,
};

describe("CommandPalette browser mode", () => {
	beforeEach(() => {
		setTauriEnv(false);
		vi.useFakeTimers();
		invokeMock.mockReset().mockResolvedValue(undefined);
		commandPaletteStore.close();
		localStorage.clear();
		for (const path of repositoriesStore.getPaths()) repositoriesStore.remove(path);
		repositoriesStore.add({ path: "/repo", displayName: "Repo" });
		repositoriesStore.setActive("/repo");
	});

	afterEach(() => {
		commandPaletteStore.close();
		repositoriesStore._testCancelPendingSave();
		setTauriEnv(true);
		vi.useRealTimers();
	});

	it("exposes only actions explicitly verified for browser execution", () => {
		const supported = action("search-files", "Search Files");
		const nativeDialog = action("open-file", "Open file");
		const hostAdministration = action("show-remote-qr", "QR for Remote Mobile Connection");
		const unknown = action("future-native-action", "Future native action");
		const { container } = render(() => (
			<CommandPalette actions={[supported, nativeDialog, hostAdministration, unknown]} browserMode />
		));

		commandPaletteStore.open();

		expect(isBrowserCommandPaletteAction(supported)).toBe(true);
		expect(isBrowserCommandPaletteAction(nativeDialog)).toBe(false);
		expect(isBrowserCommandPaletteAction(hostAdministration)).toBe(false);
		expect(container.textContent).toContain("Search Files");
		expect(container.textContent).not.toContain("Open file");
		expect(container.textContent).not.toContain("QR for Remote Mobile Connection");
		expect(container.textContent).not.toContain("Future native action");
	});

	it("keeps the complete desktop action list when browser mode is off", () => {
		const nativeDialog = action("open-file", "Open file");
		const { container } = render(() => <CommandPalette actions={[nativeDialog]} />);

		commandPaletteStore.open();

		expect(container.textContent).toContain("Open file");
	});

	it("shows the empty state when no browser-supported commands match", () => {
		const { container } = render(() => <CommandPalette actions={[action("open-file", "Open file")]} browserMode />);

		commandPaletteStore.open();

		expect(container.textContent).toContain("No matching commands");
	});

	it("executes a browser-supported command and closes", () => {
		const execute = vi.fn();
		const { getByText } = render(() => (
			<CommandPalette actions={[action("search-files", "Search Files", execute)]} browserMode />
		));
		commandPaletteStore.open();

		fireEvent.click(getByText("Search Files"));

		expect(execute).toHaveBeenCalledOnce();
		expect(commandPaletteStore.state.isOpen).toBe(false);
	});

	it("completes filename search through the shared invoke transport", async () => {
		invokeMock.mockImplementation((command: string) =>
			command === "search_files" ? Promise.resolve([FILE_RESULT]) : Promise.resolve(undefined),
		);
		const { container } = render(() => <CommandPalette actions={[]} browserMode />);
		commandPaletteStore.open();
		const input = container.querySelector<HTMLInputElement>('[aria-label="Command palette search"]')!;

		fireEvent.input(input, { target: { value: "! App" } });
		await vi.advanceTimersByTimeAsync(300);
		await flushPromises();

		expect(invokeMock).toHaveBeenCalledWith("search_files", {
			repoPath: "/repo",
			query: "App",
			limit: 50,
		});
		expect(commandPaletteStore.state.filenameSearching).toBe(false);
		expect(container.textContent).toContain("src/App.tsx");
	});

	it("completes HTTP content search without accepting another window's batch", async () => {
		let resolveContent!: (result: ContentSearchResult) => void;
		const response = new Promise<ContentSearchResult>((resolve) => {
			resolveContent = resolve;
		});
		invokeMock.mockImplementation((command: string) =>
			command === "search_content" ? response : Promise.resolve(undefined),
		);
		const { container } = render(() => <CommandPalette actions={[]} browserMode />);
		commandPaletteStore.open();
		const input = container.querySelector<HTMLInputElement>('[aria-label="Command palette search"]')!;

		fireEvent.input(input, { target: { value: "? browserNeedle" } });
		await vi.advanceTimersByTimeAsync(300);
		await flushPromises();

		emitLocalEvent("content-search-batch", {
			search_id: "another-window",
			matches: [{ ...CONTENT_RESULT.matches[0], line_text: "wrong window result" }],
			is_final: true,
			files_searched: 1,
			files_skipped: 0,
			truncated: false,
			repos_pending: 0,
			repos_searched: 0,
		});
		expect(container.textContent).not.toContain("wrong window result");
		expect(commandPaletteStore.state.contentSearching).toBe(true);

		resolveContent(CONTENT_RESULT);
		await flushPromises();

		expect(invokeMock).toHaveBeenCalledWith(
			"search_content",
			expect.objectContaining({
				repoPath: "/repo",
				query: "browserNeedle",
				caseSensitive: false,
				useRegex: false,
				wholeWord: false,
				searchId: expect.any(String),
			}),
		);
		expect(commandPaletteStore.state.contentSearching).toBe(false);
		expect(container.textContent).toContain("const browserNeedle = true;");
	});
});
