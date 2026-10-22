import { render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("../../invoke", () => ({ invoke: h.invoke }));

import { ageOpacity, BlameTab, isUntrackedBlameError, shortAge } from "../../components/GitPanel/BlameTab";
import { repositoriesStore } from "../../stores/repositories";

const REPO = "/repo";
const NOW_SEC = Math.floor(Date.now() / 1000);

/** A fresh array per call, like real IPC — the shape that made the old effect loop. */
const blame = () => [
	{
		hash: "a".repeat(40),
		author: "Stefano Straus",
		author_time: NOW_SEC - 86_400,
		summary: "one",
		line_number: 1,
		content: "import a;",
	},
	{
		hash: "a".repeat(40),
		author: "Stefano Straus",
		author_time: NOW_SEC - 86_400,
		summary: "one",
		line_number: 2,
		content: "import b;",
	},
	{
		hash: "b".repeat(40),
		author: "Paulo Reis",
		author_time: NOW_SEC - 90 * 86_400,
		summary: "two",
		line_number: 3,
		content: "export {};",
	},
];

const blameCalls = () => h.invoke.mock.calls.filter((c) => c[0] === "get_file_blame").length;
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("ageOpacity / shortAge", () => {
	it("fades the age bar from 0.85 (newest) to 0.12 (oldest)", () => {
		expect(ageOpacity(0)).toBe(0.85);
		expect(ageOpacity(1)).toBe(0.12);
		expect(ageOpacity(0.5)).toBeCloseTo(0.485, 3);
		expect(ageOpacity(-1)).toBe(0.85);
		expect(ageOpacity(Number.NaN)).toBe(0.85);
	});

	it("writes ages the gutter can hold", () => {
		const now = 1_000_000_000_000;
		const ago = (s: number) => shortAge(now / 1000 - s, now);
		expect(ago(5)).toBe("now");
		expect(ago(5 * 60)).toBe("5m");
		expect(ago(3 * 3600)).toBe("3h");
		expect(ago(2 * 86_400)).toBe("2d");
		expect(ago(15 * 86_400)).toBe("2w");
		expect(ago(120 * 86_400)).toBe("4mo");
		expect(ago(800 * 86_400)).toBe("2y");
	});
});

describe("BlameTab fetches once and settles (bug 1)", () => {
	beforeEach(() => {
		h.invoke.mockReset();
		h.invoke.mockImplementation(async (cmd: string) => (cmd === "get_file_blame" ? blame() : null));
	});

	it("does not re-fetch on its own result and leaves the loading state", async () => {
		const { container, queryByText } = render(() => <BlameTab repoPath={REPO} filePath="src/a.ts" />);
		await settle();
		await settle();
		expect(blameCalls()).toBe(1);
		expect(queryByText("Loading blame…")).toBeNull();
		expect(container.querySelector("[class*=blameScroll]")).not.toBeNull();
	});

	it("refreshes on a revision bump without flashing the loading state", async () => {
		const { queryByText } = render(() => <BlameTab repoPath={REPO} filePath="src/a.ts" />);
		await settle();
		repositoriesStore.bumpRevision(REPO);
		expect(queryByText("Loading blame…")).toBeNull();
		await settle();
		expect(blameCalls()).toBe(2);
		await settle();
		expect(blameCalls()).toBe(2);
	});

	it("a cancelled run never strands the loading state", async () => {
		let release: (v: unknown) => void = () => {};
		h.invoke.mockImplementation((cmd: string) =>
			cmd === "get_file_blame" ? new Promise((resolve) => (release = resolve)) : Promise.resolve(null),
		);
		const [file, setFile] = createSignal<string | null>("src/a.ts");
		const { queryByText, findByText } = render(() => <BlameTab repoPath={REPO} filePath={file()} />);
		expect(await findByText("Loading blame…")).toBeTruthy();
		setFile(null); // the run in flight is cancelled
		release(blame());
		await settle();
		expect(queryByText("Loading blame…")).toBeNull();
		expect(await findByText("Select a file to see who changed each line")).toBeTruthy();
	});

	it("shows git's error as one line, in place of the rows", async () => {
		h.invoke.mockImplementation(async () => {
			throw "fatal: Cannot lstat 'src/gone.ts': No such file or directory";
		});
		const { findByRole } = render(() => <BlameTab repoPath={REPO} filePath="src/gone.ts" />);
		const alert = await findByRole("alert");
		expect(alert.textContent).toContain("Cannot lstat");
		await settle();
		expect(blameCalls()).toBe(1);
	});

	it("describes a file git does not track yet instead of alarming in red", async () => {
		h.invoke.mockImplementation(async () => {
			throw "File is not tracked by git — blame unavailable: src/new.ts";
		});
		const { findByText, queryByRole } = render(() => <BlameTab repoPath={REPO} filePath="src/new.ts" />);
		expect(await findByText("This file isn't tracked yet")).toBeTruthy();
		expect(queryByRole("alert")).toBeNull();
		await settle();
		expect(blameCalls()).toBe(1);
	});

	it("recognises only git.rs's untracked refusal as that state", () => {
		expect(isUntrackedBlameError("File is not tracked by git — blame unavailable: a.ts")).toBe(true);
		expect(isUntrackedBlameError("fatal: no such path 'a.ts' in HEAD")).toBe(false);
		expect(isUntrackedBlameError("")).toBe(false);
	});
});
