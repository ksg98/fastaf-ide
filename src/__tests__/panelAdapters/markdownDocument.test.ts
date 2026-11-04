import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/event", () => ({ emitTo: vi.fn() }));
vi.mock("../../utils/filePreview", () => ({ openFileAction: vi.fn() }));

import { createMarkdownDocumentPanelAdapter } from "../../panelAdapters/markdownDocument";
import { mdTabsStore } from "../../stores/mdTabs";
import { openFileAction } from "../../utils/filePreview";
import { consumePendingHeading } from "../../utils/pendingHeadings";

const REPO = "/repo";

function link(over: Record<string, unknown> = {}) {
	return {
		kind: "file",
		absolute_path: `${REPO}/docs/other.md`,
		open_path: "docs/other.md",
		is_directory: false,
		same_document: false,
		anchor: "section",
		line: null,
		...over,
	};
}

describe("detached Markdown document adapter open-link", () => {
	let tabId: string;

	beforeEach(() => {
		vi.mocked(openFileAction).mockClear();
		tabId = mdTabsStore.add(REPO, "docs/index.md") as string;
	});

	// catches: the detached path forwards only target.line, so other.md#section opens at the top
	it("queues the #anchor for the file it opens in the main window", () => {
		createMarkdownDocumentPanelAdapter(tabId).handleAction?.("open-link", link());

		expect(vi.mocked(openFileAction).mock.calls[0]?.[0]).toBe("docs/other.md");
		expect(consumePendingHeading(`${REPO}/docs/other.md`)).toBe("section");
	});

	// catches: queueing an anchor for a link that has none leaves a stale scroll target
	it("queues nothing for a link without an anchor", () => {
		createMarkdownDocumentPanelAdapter(tabId).handleAction?.("open-link", link({ anchor: null }));

		expect(consumePendingHeading(`${REPO}/docs/other.md`)).toBeUndefined();
	});
});
