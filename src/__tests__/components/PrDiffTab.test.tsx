import { fireEvent, render } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockInvoke } from "../mocks/tauri";

// happy-dom has no layout, so the real virtualizer mounts nothing: render every row.
vi.mock("@tanstack/solid-virtual", () => ({
	createVirtualizer: (opts: { count: number }) => ({
		getTotalSize: () => opts.count * 100,
		getVirtualItems: () => Array.from({ length: opts.count }, (_, index) => ({ index, start: index * 100 })),
		measureElement: () => {},
	}),
}));

// DiffViewer measures text on a canvas, which happy-dom lacks; the body is only a marker here.
vi.mock("../../components/ui/DiffViewer", async (orig) => ({
	...(await orig<typeof import("../../components/ui/DiffViewer")>()),
	DiffViewer: () => <div>diff body</div>,
}));

import { PrDiffTab } from "../../components/PrDiffTab/PrDiffTab";

const fileDiff = (path: string) =>
	`diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-old\n+new`;
const DIFF = ["src/main.ts", "pnpm-lock.yaml", "src/main.test.ts", "gen/api.ts"].map(fileDiff).join("\n");

const body = (container: HTMLElement, path: string) =>
	Array.from(container.querySelectorAll(".fileSection"))
		.find((el) => el.textContent?.includes(path))
		?.querySelector(".fileDiff");

describe("PrDiffTab collapsing", () => {
	beforeEach(() => {
		mockInvoke.mockReset();
		mockInvoke.mockImplementation(async (cmd: string) => {
			if (cmd === "read_file") return "gen/** linguist-generated\n";
			if (cmd === "get_pr_line_threads") return { headSha: "abc", threads: [], hasNextPage: false, endCursor: null };
			return undefined;
		});
	});

	it("starts lockfile, test and linguist-generated files collapsed, with a count, and expands on click", async () => {
		// Catches: generated files expanded by default.
		const { container, findByText } = render(() => <PrDiffTab prNumber={1} prTitle="t" diff={DIFF} repoPath="/repo" />);
		await findByText(/3\s+collapsed/);
		expect(body(container, "src/main.ts")).toBeTruthy();
		expect(body(container, "pnpm-lock.yaml")).toBeFalsy();
		expect(body(container, "src/main.test.ts")).toBeFalsy();
		expect(body(container, "gen/api.ts")).toBeFalsy();

		fireEvent.click(
			Array.from(container.querySelectorAll(".fileHeader")).find((el) =>
				el.textContent?.includes("pnpm-lock.yaml"),
			) as Element,
		);
		expect(body(container, "pnpm-lock.yaml")).toBeTruthy();
	});
});
