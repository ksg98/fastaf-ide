import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { writeClipboard, SOURCE } = vi.hoisted(() => ({
	writeClipboard: vi.fn(async () => {}),
	SOURCE: ["# Title", "", "Some **bold** body and a [link](https://example.com).", "", "- one", "- two"].join("\n"),
}));

vi.mock("../../utils/clipboard", () => ({
	writeClipboard: (text: string) => writeClipboard(text),
	readClipboard: vi.fn(async () => ""),
}));

vi.mock("../../hooks/useRepository", () => ({
	useRepository: () => ({
		readFile: vi.fn().mockResolvedValue(SOURCE),
		writeFile: vi.fn().mockResolvedValue(undefined),
	}),
}));

vi.mock("../../invoke", () => ({
	invoke: vi.fn().mockResolvedValue(SOURCE),
	listen: vi.fn().mockResolvedValue(vi.fn()),
	emit: vi.fn().mockResolvedValue(undefined),
}));

import { MarkdownTab } from "../../components/MarkdownTab/MarkdownTab";
import type { FileTab } from "../../stores/mdTabs";

const TAB: FileTab = {
	id: "md-1",
	type: "file",
	repoPath: "/repo",
	filePath: "docs/README.md",
	fileName: "README.md",
};

async function renderTab() {
	const result = render(() => <MarkdownTab tab={TAB} />);
	// The header renders immediately; the content arrives from the async read.
	await waitFor(() => expect(screen.getByText(/Some/)).toBeTruthy());
	return result;
}

describe("MarkdownTab copy-all button", () => {
	beforeEach(() => {
		writeClipboard.mockClear();
	});

	it("copies the markdown source, not the rendered text", async () => {
		await renderTab();

		fireEvent.click(screen.getByTitle("Copy all as markdown"));

		await waitFor(() => expect(writeClipboard).toHaveBeenCalledOnce());
		// The whole point of "copy as markdown": the syntax survives. A DOM-text copy
		// of the preview would hand over "Some bold body and a link." with the
		// heading, emphasis and link target flattened out.
		expect(writeClipboard).toHaveBeenCalledWith(SOURCE);
	});

	it("confirms on the button itself rather than firing a toast", async () => {
		await renderTab();
		const button = screen.getByTitle("Copy all as markdown");

		fireEvent.click(button);

		await waitFor(() => expect(button.textContent).toContain("Copied"));
	});

	it("is offered before the file is read, but does nothing while there is no content", async () => {
		render(() => <MarkdownTab tab={{ ...TAB, id: "md-2" }} />);
		const button = screen.getByTitle("Copy all as markdown") as HTMLButtonElement;

		expect(button.disabled).toBe(true);
		fireEvent.click(button);
		expect(writeClipboard).not.toHaveBeenCalled();
	});
});
