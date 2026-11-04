import { marked } from "marked";

/** Keep original bytes, including CRLF and pipe/inline syntax, rather than rebuilding cells. */
export function tableSources(source: string): string[] {
	const lines = source.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g)?.filter(Boolean) ?? [];
	const normalized = lines.map((line) => line.replace(/\r\n?|\n/g, "\n"));
	const sources: string[] = [];
	let cursor = 0;
	marked.walkTokens(marked.lexer(source), (token) => {
		if (token.type !== "table") return;
		const wanted = token.raw
			.trimEnd()
			.split("\n")
			.map((line) => line.trim());
		for (let start = cursor; start < lines.length; start++) {
			const candidate = normalized
				.slice(start, start + wanted.length)
				.map((line) => line.replace(/^(?:\s*>[ \t]?)+/, "").trim());
			if (candidate.length !== wanted.length || !candidate.every((line, index) => line === wanted[index])) continue;
			let raw = lines.slice(start, start + wanted.length).join("");
			// The token owns its final newline, but not the following blank paragraph separator.
			if (!token.raw.endsWith("\n")) raw = raw.replace(/(?:\r\n|\r|\n)$/, "");
			sources.push(raw);
			cursor = start + wanted.length;
			return;
		}
		// Nested list tables omit indentation in the lexer. Keep the lexical Markdown,
		// never rendered cell text, if the container prefix prevents a direct match.
		sources.push(token.raw);
	});
	return sources;
}

export interface ChatTableActions {
	copy: (source: string) => void;
	open?: (source: string) => void;
}

/** Presentation-only enhancement, scoped to the AI Chat renderer's opt-in. */
export function enhanceChatTables(container: HTMLElement, actions: ChatTableActions): () => void {
	const observers: ResizeObserver[] = [];
	for (const table of container.querySelectorAll<HTMLTableElement>("table[data-raw-table]")) {
		if (table.closest(".chat-table")) continue;
		const source = decodeURIComponent(table.dataset.rawTable ?? "");
		const wrapper = document.createElement("section");
		wrapper.className = "chat-table";
		const toolbar = document.createElement("div");
		toolbar.className = "chat-table-actions";
		toolbar.setAttribute("role", "group");
		toolbar.setAttribute("aria-label", "Table actions");
		const viewport = document.createElement("div");
		viewport.className = "chat-table-scroll";
		viewport.tabIndex = 0;
		viewport.setAttribute("role", "region");
		viewport.setAttribute("aria-label", "Table, scroll horizontally when needed");
		const hint = document.createElement("div");
		hint.className = "chat-table-hint";
		hint.textContent = "Scroll horizontally to see all columns →";
		hint.hidden = true;
		const raw = document.createElement("pre");
		raw.className = "chat-table-source";
		raw.textContent = source;
		raw.hidden = true;
		const button = (label: string, click: () => void) => {
			const element = document.createElement("button");
			element.type = "button";
			element.textContent = label;
			element.addEventListener("click", click);
			toolbar.append(element);
			return element;
		};
		const toggle = button("Markdown", () => {
			const showingSource = toggle.getAttribute("aria-pressed") !== "true";
			toggle.setAttribute("aria-pressed", String(showingSource));
			raw.hidden = !showingSource;
			viewport.hidden = showingSource;
			hint.hidden = showingSource || viewport.scrollWidth <= viewport.clientWidth + 1;
		});
		toggle.setAttribute("aria-pressed", "false");
		button("Copy as Markdown", () => actions.copy(source));
		if (actions.open) button("Open as document", () => actions.open?.(source));
		table.before(wrapper);
		wrapper.append(toolbar, viewport, hint, raw);
		viewport.append(table);
		const rows = Array.from(table.rows);
		let longColumns = 0;
		for (let column = 0; column < (rows[0]?.cells.length ?? 0); column++) {
			const cells = rows.map((row) => row.cells[column]).filter(Boolean);
			const short = cells.every((cell) => (cell.textContent?.trim().length ?? 0) <= 18);
			if (!short) longColumns++;
			for (const cell of cells) {
				cell.classList.add(short ? "chat-table-short" : "chat-table-long");
				if (/^P[0-4]$/.test(cell.textContent?.trim() ?? "")) {
					const badge = document.createElement("span");
					badge.className = "chat-table-priority";
					badge.textContent = cell.textContent;
					cell.replaceChildren(badge);
				}
			}
		}
		if (longColumns > 1) table.classList.add("chat-table-wide");
	}
	// Existing committed segments survive streaming ticks: reconnect their observers too.
	for (const wrapper of container.querySelectorAll<HTMLElement>(".chat-table")) {
		const viewport = wrapper.querySelector<HTMLElement>(".chat-table-scroll")!;
		const table = viewport.querySelector("table")!;
		const hint = wrapper.querySelector<HTMLElement>(".chat-table-hint")!;
		const measure = () => {
			hint.hidden = viewport.hidden || viewport.scrollWidth <= viewport.clientWidth + 1;
		};
		if (typeof ResizeObserver !== "undefined") {
			const observer = new ResizeObserver(measure);
			observer.observe(viewport);
			observer.observe(table);
			observers.push(observer);
		}
		measure();
	}
	return () => {
		for (const observer of observers) observer.disconnect();
	};
}
