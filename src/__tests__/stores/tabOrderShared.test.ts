import { beforeEach, describe, expect, it } from "vitest";
import {
	type BaseTab,
	createTabManager,
	orderedThenRemainder,
	reorderIds,
	tabOrderingStore,
} from "../../stores/tabManager";
import { testInScope } from "../helpers/store";

interface TestTab extends BaseTab {
	id: string;
}

describe("reorderIds", () => {
	it("moves source before target", () => {
		const order = ["a", "b", "c"];
		reorderIds(order, "c", "a", "before");
		expect(order).toEqual(["c", "a", "b"]);
	});

	it("moves source after target", () => {
		const order = ["a", "b", "c"];
		reorderIds(order, "a", "c", "after");
		expect(order).toEqual(["b", "c", "a"]);
	});

	it("no-ops when source equals target", () => {
		const order = ["a", "b"];
		reorderIds(order, "a", "a", "before");
		expect(order).toEqual(["a", "b"]);
	});

	it("no-ops when either id is unknown", () => {
		const order = ["a", "b"];
		reorderIds(order, "x", "a", "before");
		reorderIds(order, "a", "x", "after");
		expect(order).toEqual(["a", "b"]);
	});

	it("reorders across tab kinds", () => {
		const order = ["terminal-1", "diff-2", "md-3", "editor-4"];
		reorderIds(order, "editor-4", "terminal-1", "before");
		expect(order).toEqual(["editor-4", "terminal-1", "diff-2", "md-3"]);
		reorderIds(order, "diff-2", "md-3", "after");
		expect(order).toEqual(["editor-4", "terminal-1", "md-3", "diff-2"]);
	});
});

describe("orderedThenRemainder", () => {
	it("keeps known order, then appends unseen ids", () => {
		const result = orderedThenRemainder(["a", "b"], ["a", "b", "x"], () => true);
		expect(result).toEqual(["a", "b", "x"]);
	});

	it("drops ordered ids that are no longer visible", () => {
		const result = orderedThenRemainder(["a", "b", "c"], ["a", "c"], (id) => id !== "b");
		expect(result).toEqual(["a", "c"]);
	});

	it("returns empty when nothing is visible", () => {
		expect(orderedThenRemainder(["a"], ["a"], () => false)).toEqual([]);
	});
});

/** The two ordering consumers must stay one implementation: same ops, same result. */
describe("ordering parity between tabOrderingStore and createTabManager", () => {
	beforeEach(() => {
		tabOrderingStore.clear();
	});

	it("produces the same order after the same cross-kind reorder", () => {
		testInScope(() => {
			const ids = ["terminal-1", "diff-2", "md-3", "editor-4"];

			for (const id of ids) tabOrderingStore.insert(id);
			tabOrderingStore.reorder("md-3", "terminal-1", "before");

			const mgr = createTabManager<TestTab>();
			for (const id of ids) mgr._addTabBackground({ id });
			mgr.reorderByIds("md-3", "terminal-1", "before");

			expect(tabOrderingStore.getOrdered(new Set(ids))).toEqual(mgr.getVisibleIds(null));
			expect(mgr.getVisibleIds(null)).toEqual(["md-3", "terminal-1", "diff-2", "editor-4"]);
		});
	});
});
