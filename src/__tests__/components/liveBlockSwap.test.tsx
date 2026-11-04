// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { EditorView } from "@codemirror/view";
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveMarkdownEditor } from "../../components/MarkdownTab/LiveMarkdownEditor";
import { ContentRenderer } from "../../components/ui/ContentRenderer";
import { CONVENTION_HEADER, insertTweakComment } from "../../utils/tweakComments";

const mermaidRender = vi.hoisted(() => vi.fn());
vi.mock("mermaid", () => ({ default: { initialize: vi.fn(), render: mermaidRender } }));

// jsdom has no layout; CodeMirror's measure pass asks Range for client rects.
Range.prototype.getClientRects ??= () => [] as unknown as DOMRectList;
Range.prototype.getBoundingClientRect ??= () => new DOMRect();

afterEach(() => {
	cleanup();
	mermaidRender.mockReset();
});

const DOC = "# Title\n\nSome **bold** text\n\n- [ ] one\n- [x] two\n\ntail\n";

function mount(doc: string) {
	const onSave = vi.fn().mockResolvedValue(true);
	const { container } = render(() => <LiveMarkdownEditor content={doc} onSave={onSave} readDisk={async () => doc} />);
	const editor = () => container.querySelector<HTMLElement>(".cm-editor");
	const view = () => EditorView.findFromDOM(editor() as HTMLElement) as EditorView;
	/** Rendered block whose text starts with `label`, once the renderer has stamped its source range. */
	const block = (tag: string, label: string) =>
		waitFor(() => {
			const el = Array.from(container.querySelectorAll<HTMLElement>(`${tag}[data-comment-source-start]`)).find((e) =>
				(e.textContent ?? "").trim().startsWith(label),
			);
			expect(el).toBeDefined();
			return el as HTMLElement;
		});
	const open = async (tag: string, label: string) => {
		fireEvent.click(await block(tag, label));
		await waitFor(() => expect(editor()).not.toBeNull());
	};
	const save = async () => {
		fireEvent.click(await screen.findByText("Save"));
		await waitFor(() => expect(onSave).toHaveBeenCalled());
		return onSave.mock.calls.at(-1)?.[0] as string;
	};
	return { container, onSave, editor, view, block, open, save };
}

describe("Live renders every block but one with the preview renderer", () => {
	it("produces the same DOM as the preview for an untouched document", async () => {
		// catches: Live drawing its own approximation of the preview instead of the preview renderer
		const live = mount(DOC);
		const preview = render(() => <ContentRenderer content={DOC} commentableBlocks />);
		await live.block("p", "Some");
		await waitFor(() => expect(preview.container.querySelector("p[data-comment-source-start]")).not.toBeNull());
		const html = (root: HTMLElement) => root.querySelector("#markdown-content")?.innerHTML;
		expect(html(live.container)).toBe(html(preview.container));
		expect(live.editor()).toBeNull();
	});
});

describe("Live block editing", () => {
	it("swaps only the clicked block for its exact source", async () => {
		// catches: the editor holding the whole file, or more/less than the clicked block
		const t = mount(DOC);
		await t.open("p", "Some");
		expect(t.view().state.sliceDoc()).toBe("Some **bold** text");
		expect(t.container.querySelector("h1")?.textContent).toBe("Title");
		expect(t.container.querySelectorAll(".cm-editor")).toHaveLength(1);
		expect((await t.block("p", "tail")).style.display).not.toBe("none");
	});

	it("opens a list item on its own line", async () => {
		// catches: a list item editing the whole list, or its checkbox mark shown as a widget
		const t = mount(DOC);
		await t.open("li", "one");
		expect(t.view().state.sliceDoc()).toBe("- [ ] one");
	});

	it("saves the document with only the edited block changed", async () => {
		// catches: a save that rewrites text outside the block (blank lines, trailing newline)
		const t = mount(DOC);
		await t.open("p", "Some");
		const v = t.view();
		v.dispatch({ changes: { from: v.state.doc.length, insert: "!" }, userEvent: "input.type" });
		expect(await t.save()).toBe(DOC.replace("Some **bold** text", "Some **bold** text!"));
	});

	it("Escape closes the block and renders the edit", async () => {
		// catches: an edited block staying as source, or losing the edit on close
		const t = mount(DOC);
		await t.open("p", "Some");
		const v = t.view();
		v.dispatch({ changes: { from: 0, insert: "## " }, userEvent: "input.type" });
		fireEvent.keyDown(v.contentDOM, { key: "Escape" });
		await waitFor(() => expect(t.editor()).toBeNull());
		await waitFor(() => expect(t.container.querySelectorAll("h2")).toHaveLength(1));
	});

	it("clicking another block commits the first edit and opens the right source after the text shifted", async () => {
		// catches: the second block opened at a stale offset once the first block changed length
		const t = mount(DOC);
		await t.open("p", "Some");
		const v = t.view();
		v.dispatch({ changes: { from: 0, insert: "a much longer opening " }, userEvent: "input.type" });
		fireEvent.click(await t.block("p", "tail"));
		await waitFor(() => expect(t.view().state.sliceDoc()).toBe("tail"));
		expect(t.container.querySelectorAll(".cm-editor")).toHaveLength(1);
		expect(t.container.textContent).toContain("a much longer opening Some");
		t.view().dispatch({ changes: { from: 4, insert: "?" }, userEvent: "input.type" });
		expect(await t.save()).toBe(DOC.replace("Some", "a much longer opening Some").replace("tail", "tail?"));
	});

	it("a click between blocks closes the open block", async () => {
		// catches: no way back to the fully rendered view
		const t = mount(DOC);
		await t.open("p", "Some");
		fireEvent.click(t.container.querySelector("#markdown-content") as HTMLElement);
		await waitFor(() => expect(t.editor()).toBeNull());
	});
});

describe("Live attacks", () => {
	it("a link click does not open an editor", async () => {
		// catches: every click on a link swapping its paragraph for source
		const t = mount("see [docs](#top) now\n");
		const link = await waitFor(() => {
			const a = t.container.querySelector<HTMLElement>("p[data-comment-source-start] a");
			expect(a).not.toBeNull();
			return a as HTMLElement;
		});
		fireEvent.click(link);
		expect(t.editor()).toBeNull();
	});

	it("a nested list item opens on its own line and the parent opens after it", async () => {
		// catches: nested item ranges overlapping the parent's, so the swap eats the child or duplicates it
		const doc = "- parent\n  - child\n- sibling\n";
		const t = mount(doc);
		await t.open("li", "child");
		expect(t.view().state.sliceDoc()).toBe("  - child");
		fireEvent.click(await t.block("li", "parent"));
		await waitFor(() => expect(t.view().state.sliceDoc()).toBe("- parent"));
		expect(t.container.textContent).toContain("child");
		expect(t.container.querySelectorAll(".cm-editor")).toHaveLength(1);
	});

	it("an edit that empties the block leaves the surrounding text intact", async () => {
		// catches: deleting a block's text also eating the blank lines around it
		const doc = "one\n\ntwo\n\nthree\n";
		const t = mount(doc);
		await t.open("p", "two");
		t.view().dispatch({ changes: { from: 0, to: 3, insert: "" }, userEvent: "delete" });
		expect(await t.save()).toBe("one\n\n\n\nthree\n");
	});
});

describe("Live checkboxes", () => {
	it("a click rewrites one bracket character and keeps the open block's edits", async () => {
		// catches: the checkbox toggle dropping the open editor or rewriting more than the mark
		const t = mount(DOC);
		await t.open("p", "Some");
		const v = t.view();
		v.dispatch({ changes: { from: v.state.doc.length, insert: "!" }, userEvent: "input.type" });
		const boxes = await waitFor(() => {
			const found = t.container.querySelectorAll<HTMLInputElement>("input[type=checkbox]");
			expect(found).toHaveLength(2);
			return found;
		});
		fireEvent.click(boxes[0]);
		await waitFor(() =>
			expect(t.container.querySelector<HTMLInputElement>("input[type=checkbox]")?.checked).toBe(true),
		);
		await waitFor(() => expect(t.editor()).not.toBeNull());
		expect(t.container.querySelectorAll(".cm-editor")).toHaveLength(1);
		expect(await t.save()).toBe(DOC.replace("Some **bold** text", "Some **bold** text!").replace("[ ] one", "[x] one"));
	});
});

describe("Live keeps files byte for byte", () => {
	it("keeps CRLF in an edited multi-line block", async () => {
		// catches: the block editor turning CRLF into LF, or Enter inserting a bare LF
		const doc = "first\r\nsecond\r\n\r\nother\r\n";
		const t = mount(doc);
		await t.open("p", "first");
		expect(t.view().state.sliceDoc()).toBe("first\r\nsecond");
		const v = t.view();
		v.dispatch({ changes: { from: 5, insert: v.state.lineBreak }, userEvent: "input.type" });
		expect(await t.save()).toBe("first\r\n\r\nsecond\r\n\r\nother\r\n");
	});

	it("keeps a tweak comment inside the edited block and the header outside it", async () => {
		// catches: tweak syntax dropped or duplicated by the block swap
		const ts = "2026-01-01T00:00:00.000Z";
		const doc = `${CONVENTION_HEADER}# T\n\nx <!--tweak:begin:c1-->word<!--tweak:end:c1 @${ts}\nnote--> y\n`;
		const t = mount(doc);
		await t.open("p", "x");
		const v = t.view();
		v.dispatch({ changes: { from: v.state.doc.length, insert: "!" }, userEvent: "input.type" });
		expect(await t.save()).toBe(`${doc.slice(0, -1)}!\n`);
	});
});

describe("Live rendered blocks open as source", () => {
	it("keeps a surviving diagram comment clickable after another block comment is deleted", async () => {
		// Catches: metadata cleanup strips a surviving diagram comment that cannot be paired as a PRE again.
		mermaidRender.mockResolvedValue({ svg: "<svg></svg>" });
		const diagramMarker = "<!--tweak:block:c_diagram @2026-10-26T12:00:00.000Z\nKeep diagram note-->\n";
		const paragraphMarker = "<!--tweak:block:c_remove @2026-10-26T12:00:00.000Z\nDelete paragraph note-->\n";
		const fence = "```mermaid\ngraph TD;\n  A-->B;\n```\n\n";
		const [source, setSource] = createSignal(`${diagramMarker}${fence}${paragraphMarker}After.\n`);
		const { container } = render(() => <ContentRenderer content={source()} commentableBlocks />);
		const diagram = await waitFor(() => {
			const el = container.querySelector<HTMLElement>(".mermaid-diagram");
			expect(el?.dataset.tweakId).toBe("c_diagram");
			return el!;
		});
		setSource(`${diagramMarker}${fence}After.\n`);
		await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
		expect(container.querySelector(".mermaid-diagram")).toBe(diagram);
		expect(diagram.classList.contains("tweak-block-highlight")).toBe(true);
		expect(diagram.dataset.tweakId).toBe("c_diagram");
		expect(diagram.dataset.tweakComment).toBe("Keep diagram note");
	});

	it("opens a table as its source text and renders it again on Escape", async () => {
		// catches: a table that cannot be edited because only paragraph-like blocks open an editor
		const table = "| a | b |\n|---|---|\n| 1 | 2 |";
		const t = mount(`${table}\n\nafter\n`);
		await t.open("table", "a");
		expect(t.view().state.sliceDoc()).toBe(table);
		fireEvent.keyDown(t.view().contentDOM, { key: "Escape" });
		await waitFor(() => expect(t.editor()).toBeNull());
		expect((await t.block("table", "a")).style.display).toBe("");
	});

	it("clicking an image opens the paragraph holding it", async () => {
		// catches: the image swallowing the click so its Markdown cannot be edited
		const t = mount("![alt](pic.png)\n\nafter\n");
		await t.block("p", "");
		const img = await waitFor(() => {
			const el = t.container.querySelector<HTMLElement>("p[data-comment-source-start] img");
			expect(el).not.toBeNull();
			return el as HTMLElement;
		});
		fireEvent.click(img);
		await waitFor(() => expect(t.editor()).not.toBeNull());
		expect(t.view().state.sliceDoc()).toBe("![alt](pic.png)");
	});

	it("opens a rendered mermaid diagram as its fenced source", async () => {
		// catches: the diagram replacing the <pre> without its source range, so it cannot be clicked open
		mermaidRender.mockResolvedValue({ svg: "<svg></svg>" });
		const fence = "```mermaid\ngraph TD;\n  A-->B;\n```";
		const t = mount(`${fence}\n\nafter\n`);
		const diagram = await waitFor(() => {
			const el = t.container.querySelector<HTMLElement>(".mermaid-diagram[data-comment-source-start]");
			expect(el).not.toBeNull();
			return el as HTMLElement;
		});
		fireEvent.click(diagram);
		await waitFor(() => expect(t.editor()).not.toBeNull());
		expect(t.view().state.sliceDoc()).toBe(fence);
	});

	it("shows only the editor when the diagram finishes rendering while its block is open", async () => {
		// catches: the late diagram appearing next to the open editor (two copies of one block)
		let finish: (value: { svg: string }) => void = () => {};
		mermaidRender.mockReturnValue(new Promise((resolve) => (finish = resolve)));
		const t = mount("```mermaid\ngraph TD;\n  A-->B;\n```\n\nafter\n");
		await t.open("pre", "graph");
		finish({ svg: "<svg></svg>" });
		const diagram = await waitFor(() => {
			const el = t.container.querySelector<HTMLElement>(".mermaid-diagram");
			expect(el).not.toBeNull();
			return el as HTMLElement;
		});
		await waitFor(() => expect(diagram.style.display).toBe("none"));
		expect(t.container.querySelectorAll(".cm-editor")).toHaveLength(1);
	});
});

describe("Live shows tweak highlights in every block type", () => {
	it("highlights a comment in a heading, paragraph, list item, quote, table cell, code and link", async () => {
		// catches: a block type whose renderer swallows the highlight sentinels, leaving the comment invisible
		const ts = "2026-01-01T00:00:00.000Z";
		let doc =
			"# head w0\n\npara w1\n\n- item w2\n\n> quote w3\n\n| a | b |\n|---|---|\n| cell w4 | y |\n\n```js\nconst w5 = 1;\n```\n\n[link w6](#x)\n";
		for (const [i, word] of ["w0", "w1", "w2", "w3", "w4", "w5", "w6"].entries()) {
			doc = insertTweakComment(doc, { id: `c${i}`, highlighted: word, comment: "n", createdAt: ts }, 0);
		}
		const t = mount(doc);
		await waitFor(() => expect(t.container.querySelectorAll(".tweak-highlight").length).toBe(7));
		const hosts = Array.from(t.container.querySelectorAll(".tweak-highlight")).map(
			(el) => el.parentElement?.closest("h1, li, blockquote, td, pre, a, p")?.tagName,
		);
		expect(hosts).toEqual(["H1", "P", "LI", "P", "TD", "PRE", "A"]);
	});

	it("styles the rendered highlights from the stylesheet the Live editor loads", () => {
		// catches: highlight rules scoped to the viewer tab, so Live's rendered blocks show the comment unstyled
		const css = readFileSync("src/components/ui/markdown-content.css", "utf8");
		expect(css).toContain("#markdown-content .tweak-highlight {");
		expect(css).toContain("#markdown-content .tweak-block-highlight {");
	});
});
