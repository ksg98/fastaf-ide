// @vitest-environment jsdom

import { cleanup, fireEvent, render, waitFor } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockInvoke, mockOpenUrl } = vi.hoisted(() => ({ mockInvoke: vi.fn(), mockOpenUrl: vi.fn() }));

vi.mock("../../invoke", () => ({ invoke: mockInvoke }));
vi.mock("../../utils/openUrl", () => ({ handleOpenUrl: mockOpenUrl, openLocalPath: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
	emitTo: vi.fn().mockResolvedValue(undefined),
	listen: vi.fn().mockResolvedValue(vi.fn()),
	emit: vi.fn().mockResolvedValue(undefined),
}));

import { MarkdownTab } from "../../components/MarkdownTab/MarkdownTab";
import { editorTabsStore } from "../../stores/editorTabs";
import { type FileTab, mdTabsStore } from "../../stores/mdTabs";
import { handleExternalLinkClick } from "../../utils/externalLinkClick";

const DOC = "/Users/boss/.tmp/recap-analisi.md";
const OTHER = "/Users/boss/.tmp/mailwake-pty-design.md";
const BODY = [
	"[relative](mailwake-pty-design.md)",
	"[absolute](/Users/boss/.tmp/mailwake-pty-design.md)",
	"[home](~/mailwake-pty-design.md)",
	"[heading](#section)",
	"[web](https://example.com/page)",
	"",
	"## Section",
].join("\n");

/** What `resolve_markdown_link` answers for a document that lives outside the tab's repo. */
function resolveLink(href: string) {
	if (href === "#section") return { kind: "heading", anchor: "section" };
	return { kind: "file", absolute_path: OTHER, open_path: OTHER, is_directory: false, same_document: false };
}

describe("Markdown tab opened by tuic://open: link clicks", () => {
	beforeEach(() => {
		mockInvoke.mockReset();
		mockOpenUrl.mockReset();
		mockInvoke.mockImplementation((command: string, args: { href?: string }) =>
			Promise.resolve(command === "resolve_markdown_link" ? resolveLink(args.href ?? "") : BODY),
		);
		mdTabsStore.clearAll();
		// index.tsx registers this handler on the document, before any component renders.
		document.addEventListener("click", handleExternalLinkClick);
	});

	afterEach(async () => {
		// Let the tab's focus animation frame run so jsdom's frame timer is not left pending.
		await new Promise((resolve) => setTimeout(resolve, 50));
		document.removeEventListener("click", handleExternalLinkClick);
		cleanup();
		vi.restoreAllMocks();
		mdTabsStore.clearAll();
	});

	async function renderTab() {
		// The same call the ui-tab handler makes for a file outside every registered repo.
		const id = mdTabsStore.addMcpFile("boss-recap-analisi", "/repo", DOC, false, false);
		const { container } = render(() => <MarkdownTab tab={mdTabsStore.get(id) as FileTab} />);
		await waitFor(() => expect(container.querySelectorAll("a").length).toBe(5));
		return Array.from(container.querySelectorAll("a")) as HTMLAnchorElement[];
	}

	// Catches: the document-level handler judged `anchor.href` (resolved against the app origin, so
	// http://localhost/mailwake-pty-design.md in dev and browser mode) and sent every relative link to
	// the system browser while the tab also opened the target.
	it.each([
		[0, "relative"],
		[1, "absolute"],
		[2, "~/"],
	])("opens the %s-th local link (%s) once in the markdown viewer and never in the browser", async (index) => {
		const links = await renderTab();
		const openMd = vi.spyOn(mdTabsStore, "add");
		const openEditor = vi.spyOn(editorTabsStore, "add");
		fireEvent.click(links[index]);
		await waitFor(() => expect(openMd).toHaveBeenCalledTimes(1));
		expect(openMd).toHaveBeenCalledWith("/repo", OTHER, "/repo");
		expect(openEditor).not.toHaveBeenCalled();
		expect(mockOpenUrl).not.toHaveBeenCalled();
	});

	it("scrolls to a #heading link without opening a tab or the browser", async () => {
		const links = await renderTab();
		const scroll = vi.fn();
		Element.prototype.scrollIntoView = scroll;
		const openMd = vi.spyOn(mdTabsStore, "add");
		fireEvent.click(links[3]);
		await waitFor(() => expect(scroll).toHaveBeenCalledTimes(1));
		expect(openMd).not.toHaveBeenCalled();
		expect(mockOpenUrl).not.toHaveBeenCalled();
	});

	// Catches: the document-level handler and ContentRenderer both opening an https link.
	it("opens an https link in the browser exactly once", async () => {
		const links = await renderTab();
		fireEvent.click(links[4]);
		expect(mockOpenUrl).toHaveBeenCalledTimes(1);
		expect(mockOpenUrl).toHaveBeenCalledWith("https://example.com/page");
	});
});
