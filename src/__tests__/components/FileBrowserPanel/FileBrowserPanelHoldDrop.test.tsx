import { fireEvent, render, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DirEntry } from "../../../types/fs";

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));

vi.mock("../../../invoke", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../../invoke")>();
	return { ...actual, invoke: mockInvoke, listen: () => Promise.resolve(() => {}) };
});

const { FileBrowserPanel } = await import("../../../components/FileBrowserPanel/FileBrowserPanel");
const { uiStore } = await import("../../../stores/ui");

const entry = (name: string, path: string, is_dir: boolean): DirEntry => ({
	name,
	path,
	is_dir,
	size: 10,
	modified_at: 0,
	git_status: "",
	is_ignored: false,
});

let listings = new Map<string, DirEntry[]>();
const renames = () => mockInvoke.mock.calls.filter((c) => c[0] === "rename_path").map((c) => c[1]);

const rowOf = (container: HTMLElement, name: string) => {
	const label = Array.from(container.querySelectorAll(".entryName")).find((el) => el.textContent === name);
	if (!label) throw new Error(`row not found: ${name}`);
	return label.parentElement as HTMLElement;
};

const ptr = (type: string, init: PointerEventInit) =>
	new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerType: "touch", ...init });

const holdMs = () => new Promise((r) => setTimeout(r, 400));

describe("FileBrowserPanel hold-to-drag drop target (critic 1329r3)", () => {
	const original = document.elementFromPoint;
	beforeEach(() => {
		listings = new Map();
		mockInvoke
			.mockReset()
			.mockImplementation((cmd: string, args?: Record<string, unknown>) =>
				cmd === "list_directory"
					? Promise.resolve(listings.get(`${args?.repoPath}|${args?.subdir}`) ?? [])
					: Promise.resolve(undefined),
			);
		vi.stubGlobal("matchMedia", () => ({ matches: false }));
	});
	afterEach(async () => {
		document.elementFromPoint = original;
		vi.unstubAllGlobals();
		uiStore.setFileBrowserViewMode("flat");
		await new Promise((r) => setTimeout(r, 600));
	});

	// Bug caught: `moved` flips on any pointermove after the hold arms (1px jitter),
	// so releasing a nested file in place in tree view hits the panel root as a drop
	// target (the rows are flat siblings, the nearest drop-target ancestor of a file
	// row is #file-browser-panel = repo root) and moves the file out of its folder.
	it("does not move a nested file to the root when the held finger only jitters", async () => {
		uiStore.setFileBrowserViewMode("tree");
		listings.set("/repo|.", [entry("src", "src", true)]);
		listings.set("/repo|src", [entry("a.ts", "src/a.ts", false)]);
		const { container } = render(() => (
			<FileBrowserPanel visible={true} repoPath="/repo" onClose={() => {}} onFileOpen={() => {}} />
		));
		await waitFor(() => expect(container.textContent).toContain("src"));
		fireEvent.click(rowOf(container, "src"));
		await waitFor(() => expect(container.textContent).toContain("a.ts"));
		const row = rowOf(container, "a.ts");
		document.elementFromPoint = () => row;

		row.dispatchEvent(ptr("pointerdown", { pointerId: 1, clientX: 50, clientY: 50 }));
		await holdMs();
		document.dispatchEvent(ptr("pointermove", { pointerId: 1, clientX: 51, clientY: 50 }));
		document.dispatchEvent(ptr("pointerup", { pointerId: 1, clientX: 51, clientY: 50 }));
		await Promise.resolve();

		expect(renames()).toEqual([]);
	});

	// Bug caught: with two fingers down, a shared `_ptrSrc` makes the second hold
	// (or its release) retarget or cancel the first finger's move.
	it("moves the file of the finger that dropped, ignoring a second finger released in place", async () => {
		listings.set("/repo|.", [entry("F", "F", true), entry("a.txt", "a.txt", false), entry("b.txt", "b.txt", false)]);
		const { container } = render(() => (
			<FileBrowserPanel visible={true} repoPath="/repo" onClose={() => {}} onFileOpen={() => {}} />
		));
		await waitFor(() => expect(container.textContent).toContain("b.txt"));
		const f = rowOf(container, "F");
		const a = rowOf(container, "a.txt");
		const b = rowOf(container, "b.txt");
		document.elementFromPoint = (x: number) => (x < 100 ? f : x < 200 ? a : b);

		a.dispatchEvent(ptr("pointerdown", { pointerId: 1, clientX: 150, clientY: 10 }));
		b.dispatchEvent(ptr("pointerdown", { pointerId: 2, clientX: 250, clientY: 10 }));
		await holdMs();
		document.dispatchEvent(ptr("pointermove", { pointerId: 1, clientX: 20, clientY: 10 }));
		document.dispatchEvent(ptr("pointerup", { pointerId: 2, clientX: 250, clientY: 10 }));
		document.dispatchEvent(ptr("pointerup", { pointerId: 1, clientX: 20, clientY: 10 }));
		await waitFor(() => expect(renames()).toHaveLength(1));

		expect(renames()[0]).toMatchObject({ from: "a.txt", to: "F/a.txt" });
	});
});
