import {
	cursorCharLeft,
	cursorCharRight,
	deleteCharBackward,
	deleteCharForward,
	history,
	undo,
} from "@codemirror/commands";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { openSearchPanel, search, searchPanelOpen } from "@codemirror/search";
import { EditorSelection, EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	addTweakCommentAtSelection,
	liveDecorations,
	liveLineSeparator,
	liveMarkdown,
	liveModeSupported,
	loadMarkdownLanguage,
	tweakHiddenRanges,
} from "../../components/MarkdownTab/liveMarkdown";
import {
	CONVENTION_HEADER,
	insertTweakComment,
	OverlappingCommentError,
	parseInlineTweakComments,
} from "../../utils/tweakComments";

const TS = "2026-01-01T00:00:00.000Z";
const inline = (id: string, text: string, body: string) =>
	`<!--tweak:begin:${id}-->${text}<!--tweak:end:${id} @${TS}\n${body}-->`;

const views: EditorView[] = [];
beforeEach(() => {
	vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame"] });
});
afterEach(() => {
	for (const v of views.splice(0)) v.destroy();
	document.body.innerHTML = "";
	vi.clearAllTimers();
	vi.useRealTimers();
});

function stateOf(doc: string, anchor = 0, head = anchor, extra: Extension[] = []): EditorState {
	return EditorState.create({
		doc,
		selection: EditorSelection.single(anchor, head),
		extensions: [loadMarkdownLanguage(), liveLineSeparator(doc), liveMarkdown(), ...extra],
	});
}
function viewOf(doc: string, anchor = 0, head = anchor, extra: Extension[] = []): EditorView {
	const parent = document.createElement("div");
	document.body.appendChild(parent);
	const view = new EditorView({ state: stateOf(doc, anchor, head, extra), parent });
	views.push(view);
	return view;
}
const text = (s: EditorState) => s.sliceDoc();
const texts = (s: EditorState, ranges: { from: number; to: number }[]) => ranges.map((r) => s.sliceDoc(r.from, r.to));

/** Independent oracle: every begin has an end, and the parser sees the same number of comments. */
function assertBalanced(doc: string) {
	const begins = doc.match(/<!--tweak:begin:/g)?.length ?? 0;
	const ends = doc.match(/<!--tweak:end:/g)?.length ?? 0;
	expect(begins).toBe(ends);
	expect(parseInlineTweakComments(doc).length).toBe(begins);
}

describe("lossless round trip", () => {
	const WITH_TWEAK = `${CONVENTION_HEADER}# T\n\nx ${inline("c1", "word", "note **b**")} y\n\n- [~] item\n`;

	it("saves the buffer byte for byte, LF with tweak comments", () => {
		// catches: any serializer rewriting the file
		const s = stateOf(WITH_TWEAK);
		expect(text(s)).toBe(WITH_TWEAK);
	});

	it("saves CRLF documents byte for byte", () => {
		// catches: line endings normalised to LF on save
		const doc = "# T\r\n\r\ntext **b**\r\nend\r\n";
		const s = stateOf(doc);
		expect(text(s)).toBe(doc);
	});

	it("an edit elsewhere changes only those bytes and keeps the comment", () => {
		// catches: comment lost after edit elsewhere in the file
		const v = viewOf(WITH_TWEAK);
		v.dispatch({ changes: { from: WITH_TWEAK.indexOf("# T") + 1, insert: "X" }, userEvent: "input.type" });
		expect(text(v.state)).toBe(WITH_TWEAK.replace("# T", "#X T"));
		expect(parseInlineTweakComments(text(v.state))).toHaveLength(1);
	});

	it("treats LF inside a tweak comment as part of the comment, not as mixed endings", () => {
		// catches: Live refused (or CRLF lost) on CRLF files the viewer commented on
		const doc = `# T\r\n\r\nx ${inline("c1", "w", "n")}\r\n`;
		expect(liveModeSupported(doc)).toBe(true);
		expect(text(stateOf(doc))).toBe(doc);
	});

	it("declines mixed line endings and large files", () => {
		// catches: silently rewriting mixed endings
		expect(liveModeSupported("a\r\nb\nc")).toBe(false);
		expect(liveModeSupported("a\rb")).toBe(false);
		expect(liveModeSupported("a\r\nb\r\n")).toBe(true);
		expect(liveModeSupported("a\nb\n")).toBe(true);
		expect(liveModeSupported("x".repeat(600 * 1024))).toBe(false);
	});
});

describe("tweak comment presentation", () => {
	it("hides begin marker, end marker with body, and the convention header", () => {
		// catches: raw comment syntax visible in live mode
		const doc = `${CONVENTION_HEADER}a ${inline("c1", "word", "multi\nline")} b`;
		const s = stateOf(doc, doc.length);
		expect(texts(s, tweakHiddenRanges(s))).toEqual([
			CONVENTION_HEADER,
			"<!--tweak:begin:c1-->",
			`<!--tweak:end:c1 @${TS}\nmulti\nline-->`,
		]);
	});

	it("hides block and item comments", () => {
		// catches: block/item comments left visible
		const block = `<!--tweak:block:b1 @${TS}\nblock note-->\n`;
		const item = `  <!--tweak:item:i1 @${TS}\n  item note-->\n`;
		const doc = `${block}# H\n\n- a\n${item}- b\n`;
		const s = stateOf(doc, doc.length);
		expect(texts(s, tweakHiddenRanges(s))).toEqual([block, item]);
	});

	it("keeps tweak markers hidden even on the cursor line", () => {
		// catches: markers revealed when the cursor is on their line
		const doc = `a ${inline("c1", "word", "n")} b`;
		const s = stateOf(doc, 3);
		expect(texts(s, tweakHiddenRanges(s))).toHaveLength(2);
	});

	it("marks the highlighted text with the viewer highlight class and the comment as title", () => {
		// catches: highlighted text unstyled or comment body unreachable
		const doc = `a ${inline("c1", "word", "my note")} b`;
		const s = stateOf(doc);
		const found: { text: string; cls: string; title: string }[] = [];
		liveDecorations(s).between(0, doc.length, (from, to, deco) => {
			const spec = deco.spec as { class?: string; attributes?: { title?: string } };
			if (spec.class?.includes("tweak-highlight")) {
				found.push({ text: s.sliceDoc(from, to), cls: spec.class, title: spec.attributes?.title ?? "" });
			}
		});
		expect(found).toEqual([{ text: "word", cls: "tweak-highlight", title: "my note" }]);
	});
});

describe("tweak markers are atomic", () => {
	const DOC = `a ${inline("c1", "word", "note")} b`;
	const begin = DOC.indexOf("<!--tweak:begin");
	const hs = begin + "<!--tweak:begin:c1-->".length;

	it("the cursor jumps over the hidden begin marker", () => {
		// catches: caret parked inside hidden syntax
		const v = viewOf(DOC, begin);
		cursorCharRight(v);
		expect(v.state.selection.main.head).toBe(hs);
		cursorCharLeft(v);
		expect(v.state.selection.main.head).toBe(begin);
	});

	it("Backspace right after the end marker deletes the last highlighted char and keeps the pair", () => {
		// catches: Backspace after a comment doing nothing, or orphaning a marker
		const end = DOC.indexOf(" b");
		const v = viewOf(DOC, end);
		deleteCharBackward(v);
		assertBalanced(text(v.state));
		expect(parseInlineTweakComments(text(v.state))[0].highlighted).toBe("wor");
	});

	it("Delete right before the begin marker deletes the first highlighted char and keeps the pair", () => {
		// catches: Delete before a comment doing nothing, or orphaning a marker
		const v = viewOf(DOC, begin);
		deleteCharForward(v);
		assertBalanced(text(v.state));
		expect(parseInlineTweakComments(text(v.state))[0].highlighted).toBe("ord");
	});

	it("Backspace after a one-character comment removes the whole pair", () => {
		// catches: empty highlight pair left behind
		const doc = `a ${inline("c1", "w", "n")} b`;
		const v = viewOf(doc, doc.indexOf(" b"));
		deleteCharBackward(v);
		expect(text(v.state)).toBe("a  b");
	});

	it("selecting all the highlighted text and deleting removes the whole pair", () => {
		// catches: empty highlight pair left behind, or half a pair removed
		const v = viewOf(DOC, hs, hs + 4);
		deleteCharBackward(v);
		expect(text(v.state)).toBe("a  b");
		assertBalanced(text(v.state));
	});

	it("a selection ending inside the highlight and crossing the end marker keeps the pair intact", () => {
		// catches: deleting into the end marker
		const v = viewOf(DOC, 0, hs + 2);
		deleteCharBackward(v);
		assertBalanced(text(v.state));
		expect(parseInlineTweakComments(text(v.state))[0].highlighted).toBe("rd");
	});

	it("select-all delete removes everything, pairs included", () => {
		// catches: leftover marker fragments after select-all
		const v = viewOf(DOC, 0, DOC.length);
		deleteCharBackward(v);
		expect(text(v.state)).toBe("");
	});

	it("deleting across two comments never orphans either", () => {
		// catches: partial removal across neighbouring comments
		const doc = `${inline("c1", "one", "n1")} mid ${inline("c2", "two", "n2")}`;
		const v = viewOf(doc, doc.indexOf("ne"), doc.indexOf("tw") + 1);
		deleteCharBackward(v);
		assertBalanced(text(v.state));
	});

	it("undo restores a deleted pair exactly", () => {
		// catches: filter breaking history
		const v = viewOf(DOC, hs, hs + 4, [history()]);
		deleteCharBackward(v);
		undo(v);
		expect(text(v.state)).toBe(DOC);
	});
});

describe("add a comment from a selection", () => {
	it("wraps the selection using the same writer as the viewer", () => {
		// catches: a second, divergent comment format
		const doc = "# T\n\nfoo bar foo\n";
		const second = doc.lastIndexOf("foo");
		const v = viewOf(doc, second, second + 3);
		const comment = { id: "c1", comment: "why", createdAt: TS };
		addTweakCommentAtSelection(v, comment);
		expect(text(v.state)).toBe(insertTweakComment(doc, { ...comment, highlighted: "foo" }, 1));
		expect(parseInlineTweakComments(text(v.state))).toHaveLength(1);
	});

	it("propagates the overlap error instead of nesting", () => {
		// catches: nested comments corrupting both
		const doc = `x ${inline("c1", "word", "n")} y`;
		const hs = doc.indexOf(">word") + 1;
		const v = viewOf(doc, hs, hs + 4);
		expect(() => addTweakCommentAtSelection(v, { id: "c2", comment: "z", createdAt: TS })).toThrow(
			OverlappingCommentError,
		);
	});

	it("keeps CRLF documents CRLF", () => {
		// catches: writer normalising line endings
		const doc = "a\r\nfoo\r\nb\r\n";
		const from = doc.replace(/\r\n/g, "\n").indexOf("foo"); // CodeMirror offsets: one per line break
		const v = viewOf(doc, from, from + 3);
		addTweakCommentAtSelection(v, { id: "c1", comment: "n", createdAt: TS });
		expect(text(v.state).replace(/\r\n/g, "")).not.toContain("\n");
		expect(text(v.state)).toContain("a\r\n<!--tweak:begin:c1-->foo<!--tweak:end:c1");
		expect(text(v.state).endsWith("-->\r\nb\r\n")).toBe(true);
	});
});

describe("editor features keep working", () => {
	it("highlights nested code languages inside fences", async () => {
		// catches: markdown parser configured without codeLanguages
		const doc = "```js\nconst answer = 42;\n```\n";
		const v = viewOf(doc);
		let inner = "";
		for (let i = 0; i < 40 && inner !== "VariableDefinition"; i++) {
			const tree = ensureSyntaxTree(v.state, doc.length, 1000) ?? syntaxTree(v.state);
			inner = tree.resolveInner(doc.indexOf("answer"), 1).name;
			if (inner !== "VariableDefinition") await new Promise((r) => setTimeout(r, 50));
		}
		expect(inner).toBe("VariableDefinition");
	});

	it("Cmd+F search panel opens", () => {
		// catches: search extension dropped from the live editor
		const v = viewOf("hello **world**", 0, 0, [search()]);
		openSearchPanel(v);
		expect(searchPanelOpen(v.state)).toBe(true);
	});
});

describe("attacks", () => {
	it("typing inside the highlighted text keeps the comment and updates the highlight", () => {
		// catches: guard rejecting ordinary edits inside a highlight
		const doc = `a ${inline("c1", "word", "n")} b`;
		const v = viewOf(doc);
		const at = doc.indexOf("word") + 2;
		v.dispatch({ changes: { from: at, insert: "X" }, userEvent: "input.type" });
		expect(parseInlineTweakComments(text(v.state))[0].highlighted).toBe("woXrd");
	});

	it("replacing a selection that starts before the begin marker and ends mid-word keeps the pair", () => {
		// catches: half a pair removed by a replace
		const doc = `a ${inline("c1", "word", "n")} b`;
		const v = viewOf(doc, 0, doc.indexOf("word") + 2);
		v.dispatch({ ...v.state.replaceSelection("Z"), userEvent: "input.paste" });
		assertBalanced(text(v.state));
		expect(parseInlineTweakComments(text(v.state))[0].highlighted).toBe("rd");
	});

	it("CRLF document with a comment: deleting the highlight removes the pair and keeps CRLF", () => {
		// catches: offset drift between document and source on CRLF files
		const doc = `x\r\n${inline("c1", "word", "n")}\r\ny\r\n`.replace(/(?<!\r)\n(?=n-->)/, "\n");
		const lf = doc.replace(/\r\n/g, "\n");
		const hs = lf.indexOf("word");
		const v = viewOf(doc, hs, hs + 4);
		deleteCharBackward(v);
		expect(text(v.state)).toBe("x\r\n\r\ny\r\n");
	});
});
