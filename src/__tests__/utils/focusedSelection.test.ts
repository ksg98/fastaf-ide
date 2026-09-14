import { describe, expect, it } from "vitest";
import { getFocusedFrameSelection } from "../../utils/focusedSelection";

/**
 * happy-dom does not implement iframe focus or per-document selections, so we
 * model the two things the walk actually touches: `activeElement` and
 * `defaultView.getSelection()`.
 */
function fakeDoc(opts: { activeElement?: unknown; selection?: string }): Document {
	return {
		activeElement: opts.activeElement ?? null,
		defaultView: {
			getSelection: () => ({ toString: () => opts.selection ?? "" }),
		},
	} as unknown as Document;
}

function fakeIframe(contentDocument: Document | null): Element {
	return { tagName: "IFRAME", contentDocument } as unknown as Element;
}

/** An iframe whose contentDocument throws, as cross-origin frames do. */
function crossOriginIframe(): Element {
	return {
		tagName: "IFRAME",
		get contentDocument(): Document {
			throw new DOMException("Blocked a frame with origin");
		},
	} as unknown as Element;
}

describe("getFocusedFrameSelection", () => {
	it("returns the selection of a focused same-origin iframe", () => {
		const inner = fakeDoc({ selection: "48G  target/debug" });
		const host = fakeDoc({ activeElement: fakeIframe(inner), selection: "host text" });

		expect(getFocusedFrameSelection(host)).toBe("48G  target/debug");
	});

	it("returns empty when focus is not inside an iframe", () => {
		// The host selection is the caller's own fallback — this helper must not
		// claim it, or it would shadow the terminal selection on every copy.
		const host = fakeDoc({ activeElement: { tagName: "DIV" }, selection: "host text" });

		expect(getFocusedFrameSelection(host)).toBe("");
	});

	it("returns empty when nothing is selected inside the focused iframe", () => {
		const inner = fakeDoc({ selection: "" });
		const host = fakeDoc({ activeElement: fakeIframe(inner), selection: "host text" });

		expect(getFocusedFrameSelection(host)).toBe("");
	});

	it("bails out on a cross-origin iframe instead of throwing", () => {
		const host = fakeDoc({ activeElement: crossOriginIframe(), selection: "host text" });

		expect(getFocusedFrameSelection(host)).toBe("");
	});

	it("bails out when the iframe has no document yet", () => {
		const host = fakeDoc({ activeElement: fakeIframe(null), selection: "host text" });

		expect(getFocusedFrameSelection(host)).toBe("");
	});

	it("descends into nested same-origin iframes", () => {
		const deepest = fakeDoc({ selection: "nested text" });
		const middle = fakeDoc({ activeElement: fakeIframe(deepest) });
		const host = fakeDoc({ activeElement: fakeIframe(middle) });

		expect(getFocusedFrameSelection(host)).toBe("nested text");
	});

	it("terminates on a self-referential frame and claims nothing", () => {
		// The walk never leaves the root document, so the host selection stays the
		// caller's to resolve — and the depth cap keeps this from spinning.
		const selfRef = fakeDoc({ selection: "loop" });
		(selfRef as { activeElement: unknown }).activeElement = fakeIframe(selfRef);

		expect(getFocusedFrameSelection(selfRef)).toBe("");
	});
});
