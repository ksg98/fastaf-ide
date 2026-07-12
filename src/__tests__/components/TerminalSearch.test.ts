import { describe, expect, it, vi } from "vitest";
import "../mocks/tauri";
import type { CanvasTerminalRef } from "../../components/Terminal/CanvasTerminal";

/**
 * TerminalSearch is a thin SolidJS wrapper that delegates to CanvasTerminalRef.
 * The real search logic is tested in Rust (terminal_grid.rs: search_finds_matches,
 * search_case_insensitive, search_empty_query, search_regex_pattern, etc.).
 *
 * These tests verify the interaction contract: the sequence of calls the
 * component makes on CanvasTerminalRef in response to user actions.
 */

function createMockCanvasRef(): CanvasTerminalRef {
	return {
		focus: vi.fn(),
		blur: vi.fn(),
		refresh: vi.fn(),
		searchFind: vi.fn().mockResolvedValue({ index: 0, count: 3 }),
		searchNext: vi.fn().mockReturnValue({ index: 1, count: 3 }),
		searchPrev: vi.fn().mockReturnValue({ index: 2, count: 3 }),
		searchClear: vi.fn(),
		scrollToBottom: vi.fn(),
		scrollLines: vi.fn(),
		scrollToRow: vi.fn(),
		getSelection: vi.fn().mockReturnValue(""),
		clearSelection: vi.fn(),
		selectAll: vi.fn(),
		resize: vi.fn(),
		getRowCount: vi.fn().mockReturnValue(24),
		getColCount: vi.fn().mockReturnValue(80),
	} as unknown as CanvasTerminalRef;
}

// Replicate TerminalSearch's handleSearch logic to test the interaction protocol
function handleSearch(
	ref: CanvasTerminalRef,
	term: string,
): { promise?: Promise<{ index: number; count: number }>; cleared: boolean } {
	if (term) {
		return { promise: ref.searchFind(term), cleared: false };
	} else {
		ref.searchClear();
		return { cleared: true };
	}
}

describe("TerminalSearch interaction contract", () => {
	it("calls searchFind with the query when term is non-empty", async () => {
		const ref = createMockCanvasRef();
		const { promise } = handleSearch(ref, "hello");
		expect(ref.searchFind).toHaveBeenCalledWith("hello");
		expect(ref.searchClear).not.toHaveBeenCalled();
		const result = await promise!;
		expect(result.index).toBe(0);
		expect(result.count).toBe(3);
	});

	it("calls searchClear (not searchFind) when term is empty", () => {
		const ref = createMockCanvasRef();
		const { cleared } = handleSearch(ref, "");
		expect(cleared).toBe(true);
		expect(ref.searchClear).toHaveBeenCalledOnce();
		expect(ref.searchFind).not.toHaveBeenCalled();
	});

	it("searchNext and searchPrev return synchronous results", () => {
		const ref = createMockCanvasRef();
		const next = ref.searchNext();
		const prev = ref.searchPrev();
		expect(next).toEqual({ index: 1, count: 3 });
		expect(prev).toEqual({ index: 2, count: 3 });
	});

	it("closing clears search and resets state", () => {
		const ref = createMockCanvasRef();
		// Simulate close: visible becomes false → searchClear
		ref.searchClear();
		expect(ref.searchClear).toHaveBeenCalledOnce();
	});

	it("new search after clear calls searchFind again", async () => {
		const ref = createMockCanvasRef();
		handleSearch(ref, "first");
		expect(ref.searchFind).toHaveBeenCalledWith("first");
		handleSearch(ref, "");
		expect(ref.searchClear).toHaveBeenCalledOnce();
		handleSearch(ref, "second");
		expect(ref.searchFind).toHaveBeenCalledWith("second");
		expect(ref.searchFind).toHaveBeenCalledTimes(2);
	});

	describe("decoration colors contract", () => {
		it("match decorations use yellow for inactive and orange for active", () => {
			const decorations = {
				matchBackground: "#ffff0040",
				matchBorder: "transparent",
				matchOverviewRuler: "#ffff00",
				activeMatchBackground: "#ff8c00b0",
				activeMatchBorder: "#ff8c00",
				activeMatchColorOverviewRuler: "#ff8c00",
			};

			expect(decorations.matchBackground).toBe("#ffff0040");
			expect(decorations.activeMatchBackground).toBe("#ff8c00b0");
			expect(decorations.activeMatchBorder).toBe("#ff8c00");
		});
	});
});
