import { render } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";

const measured: Array<string | undefined> = [];
vi.mock("@tanstack/solid-virtual", () => ({
	createVirtualizer: (opts: { count: number }) => ({
		getTotalSize: () => opts.count * 100,
		getVirtualItems: () => Array.from({ length: opts.count }, (_, index) => ({ index, start: index * 100 })),
		// The real one reads data-index at once and skips the element without it.
		measureElement: (el: HTMLElement) => measured.push(el.dataset.index),
	}),
}));
vi.mock("../../components/ui/DiffViewer", async (orig) => ({
	...(await orig<typeof import("../../components/ui/DiffViewer")>()),
	DiffViewer: () => <div>diff body</div>,
}));

import { DiffFileList } from "../../components/shared/DiffFileList";
import { parseDiffFiles } from "../../components/ui/DiffViewer";

describe("DiffFileList row measurement", () => {
	// Catches: rows never measured (Solid sets data-index after ref), so tall files overlap the next row.
	it("hands each row to the virtualizer with its data-index already set", () => {
		const raw = ["a.ts", "b.ts"].map((f) => `diff --git a/${f} b/${f}\n@@ -1 +1 @@\n-x\n+y`).join("\n");
		render(() => <DiffFileList files={parseDiffFiles(raw)} mode="unified" />);
		expect(measured).toEqual(["0", "1"]);
	});
});
