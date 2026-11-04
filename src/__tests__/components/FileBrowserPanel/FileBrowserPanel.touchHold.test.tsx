import { render, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DirEntry } from "../../../types/fs";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));

vi.mock("../../../invoke", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../invoke")>();
	return { ...actual, invoke: mockInvoke, listen: () => Promise.resolve(() => {}) };
});

const { FileBrowserPanel } = await import("../../../components/FileBrowserPanel/FileBrowserPanel");

const entry = (name: string, isDir: boolean, path = name): DirEntry => ({
	name,
	path,
	is_dir: isDir,
	size: 0,
	modified_at: 0,
	git_status: "",
	is_ignored: false,
});

let listing: DirEntry[] = [];

beforeEach(() => {
	mockInvoke
		.mockReset()
		.mockImplementation((cmd: string) => Promise.resolve(cmd === "list_directory" ? listing : undefined));
});

afterEach(async () => {
	vi.unstubAllGlobals();
	document.body.innerHTML = "";
	await new Promise((resolve) => setTimeout(resolve, 50));
});

const pointer = (type: string, pointerType: string, pointerId: number, x: number, y: number) =>
	new PointerEvent(type, {
		bubbles: true,
		cancelable: true,
		button: 0,
		pointerId,
		pointerType,
		clientX: x,
		clientY: y,
	});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const renameCalls = () => mockInvoke.mock.calls.filter(([cmd]) => cmd === "rename_path");

const mount = async () => {
	const { container, queryByText } = render(() => (
		<FileBrowserPanel visible={true} repoPath="/repo" onClose={() => {}} onFileOpen={() => {}} />
	));
	await waitFor(() => expect(queryByText(listing[0].name)).not.toBeNull());
	const rows = Array.from(container.querySelectorAll(".entry")) as HTMLElement[];
	return (name: string) => rows.find((r) => r.textContent?.includes(name)) as HTMLElement;
};

describe("FileBrowserPanel touch long press (#1329-a31a, round 2 critic)", () => {
	// Catches: a long press that never moves (the gesture that opens a context menu on
	// touch) lifting the row and dropping it on the panel root, which is a folder drop
	// target — moving a nested file out of its folder with no drag at all.
	it.each(["touch", "pen"])("%s: a hold released in place does not move the file", async (pointerType) => {
		vi.stubGlobal("matchMedia", () => ({ matches: false }));
		listing = [entry("a.txt", false, "docs/a.txt")];
		const row = await mount();
		const original = document.elementFromPoint;
		document.elementFromPoint = () => row("a.txt");
		try {
			row("a.txt").dispatchEvent(pointer("pointerdown", pointerType, 1, 50, 50));
			await sleep(450);
			document.dispatchEvent(pointer("pointermove", pointerType, 1, 51, 50)); // 1 px jitter
			document.dispatchEvent(pointer("pointerup", pointerType, 1, 51, 50));
			await sleep(20);
		} finally {
			document.elementFromPoint = original;
		}
		expect(renameCalls()).toHaveLength(0);
	});

	// Catches: the drop reading shared mutable `_ptrSrc`, so a second finger resting on
	// another row (palm) makes the first finger's drop move the second finger's file.
	it("a second finger held on another row does not change which file the first finger drops", async () => {
		listing = [entry("docs", true), entry("a.txt", false), entry("b.txt", false)];
		const row = await mount();
		const original = document.elementFromPoint;
		document.elementFromPoint = () => row("docs");
		try {
			row("a.txt").dispatchEvent(pointer("pointerdown", "touch", 1, 50, 50));
			row("b.txt").dispatchEvent(pointer("pointerdown", "touch", 2, 50, 80));
			await sleep(450);
			document.dispatchEvent(pointer("pointermove", "touch", 1, 50, 20));
			document.dispatchEvent(pointer("pointerup", "touch", 1, 50, 10));
			await sleep(20);
			document.dispatchEvent(pointer("pointercancel", "touch", 2, 50, 80));
		} finally {
			document.elementFromPoint = original;
		}
		expect(renameCalls().map(([, args]) => (args as { from: string }).from)).toEqual(["a.txt"]);
	});
});
