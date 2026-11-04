// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { ContentRenderer } from "../../components/ui/ContentRenderer";
import { tableSources } from "../../components/ui/chatTables";

afterEach(() => {
	cleanup();
	document.querySelector("style[data-chat-table-test]")?.remove();
});

// Catches: toggle/copy reconstructing cells, dropping escaped pipes, inline markup or CRLF.
it("toggles, copies and opens each table's exact source independently", async () => {
	const first =
		"| Storia | Priorità | Cosa manca |\r\n| --- | --- | --- |\r\n| #1918 | P2 | Keep **bold** and a\\|b. |";
	const second = "| Key | Value |\n| --- | --- |\n| two | `source` |";
	const copy = vi.fn();
	const open = vi.fn();
	const { container } = render(() => (
		<ContentRenderer content={`${first}\r\n\r\nProse\n\n${second}`} tableActions={{ copy, open }} />
	));
	await Promise.resolve();
	const tables = container.querySelectorAll<HTMLElement>(".chat-table");
	expect(tables).toHaveLength(2);
	for (const [index, source] of [first, second].entries()) {
		const table = tables[index];
		const buttons = table.querySelectorAll("button");
		fireEvent.click(buttons[0]);
		expect(buttons[0].getAttribute("aria-pressed")).toBe("true");
		expect(table.querySelector("pre")?.textContent).toBe(source);
		expect(table.querySelector<HTMLElement>(".chat-table-scroll")?.hidden).toBe(true);
		fireEvent.click(buttons[1]);
		expect(copy).toHaveBeenLastCalledWith(source);
		fireEvent.click(buttons[2]);
		expect(open).toHaveBeenLastCalledWith(source);
		fireEvent.click(buttons[0]);
		expect(table.querySelector<HTMLElement>(".chat-table-scroll")?.hidden).toBe(false);
	}
});
// Catches: short priority fields inheriting break-word and squeezing the long text column.
it("protects short fields and badges priorities without changing cell text", async () => {
	const style = document.createElement("style");
	style.dataset.chatTableTest = "";
	style.textContent = readFileSync(resolve(process.cwd(), "src/components/ui/markdown-content.css"), "utf8");
	document.head.append(style);
	const { container } = render(() => (
		<ContentRenderer
			content={
				"| Storia | Priorità | Cosa manca |\n| --- | --- | --- |\n| #1918 | P2 | Aggiornare le opzioni della sessione senza interrompere la chat. |"
			}
			tableActions={{ copy: vi.fn(), open: vi.fn() }}
		/>
	));
	await Promise.resolve();
	const cells = container.querySelectorAll("td");
	expect(getComputedStyle(cells[0]).whiteSpace).toBe("nowrap");
	expect(getComputedStyle(cells[1]).whiteSpace).toBe("nowrap");
	expect(cells[1].querySelector(".chat-table-priority")?.textContent).toBe("P2");
	expect(getComputedStyle(cells[2]).minWidth).toBe("160px");
});
// Catches: late streamed rows reusing stale source or adding duplicate toolbars to committed blocks.
it("refreshes streamed tables and leaves non-chat consumers unchanged", async () => {
	const initial = "| A | B |\n| - | - |\n| one | two |";
	const [content, setContent] = createSignal(initial);
	const copy = vi.fn();
	const { container } = render(() => (
		<ContentRenderer content={content()} incremental tableActions={{ copy, open: vi.fn() }} />
	));
	await Promise.resolve();
	setContent(`${initial}\n| three | four |`);
	await Promise.resolve();
	expect(container.querySelectorAll(".chat-table-actions")).toHaveLength(1);
	fireEvent.click(container.querySelectorAll(".chat-table-actions button")[1]);
	expect(copy).toHaveBeenLastCalledWith(`${initial}\n| three | four |`);
	const plain = render(() => <ContentRenderer content={initial} />);
	await Promise.resolve();
	expect(plain.container.querySelector(".chat-table")).toBeNull();
});
// Catches: code-fenced examples or raw HTML tables stealing another table's source.
it("maps only Markdown tables and preserves quoted container source", () => {
	const raw = "| A | B |\n| --- | --- |\n| one | two |";
	expect(tableSources(`\`\`\`md\n${raw}\n\`\`\`\n\n<table><tr><td>HTML</td></tr></table>\n\n${raw}`)).toEqual([raw]);
	const quoted =
		raw
			.split("\n")
			.filter(Boolean)
			.map((line) => `> ${line}`)
			.join("\n") + "\n";
	expect(tableSources(quoted)).toEqual([quoted.slice(0, -1)]);
});
