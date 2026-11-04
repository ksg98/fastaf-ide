import { render, waitFor } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { HtmlPreviewTab } from "../../components/HtmlPreviewTab/HtmlPreviewTab";
import type { HtmlPreviewTab as HtmlPreviewTabData } from "../../stores/mdTabs";
import { handleOpenUrl } from "../../utils/openUrl";
import { nextAnimationFrame } from "../helpers/animationFrame";

vi.mock("../../hooks/useRepository", () => ({
	useRepository: () => ({
		readFile: vi
			.fn()
			.mockResolvedValue("<html><head></head><body><a href='https://example.org'>Docs</a></body></html>"),
	}),
}));
vi.mock("../../utils/openUrl", () => ({ handleOpenUrl: vi.fn(), openLocalPath: vi.fn() }));

afterEach(() => {
	vi.clearAllMocks();
	document.body.innerHTML = "";
});

it("routes a preview frame link message to the external opener and ignores other frames", async () => {
	const tab = {
		id: "preview-1",
		type: "html-preview",
		repoPath: "/repo",
		filePath: "index.html",
		fileName: "index.html",
	} as HtmlPreviewTabData;
	const { container, unmount } = render(() => <HtmlPreviewTab tab={tab} />);
	await waitFor(() =>
		expect(container.querySelector("iframe")?.getAttribute("srcdoc")).toContain("tuic-external-links"),
	);
	const iframe = container.querySelector("iframe")!;
	// happy-dom dispatches the real srcdoc load in a frame; do not leave it pending.
	await nextAnimationFrame();
	window.dispatchEvent(
		new MessageEvent("message", { data: { type: "tuic:preview-open-url", url: "https://example.org" } }),
	);
	expect(handleOpenUrl).not.toHaveBeenCalled();
	const own = new MessageEvent("message", { data: { type: "tuic:preview-open-url", url: "https://example.org" } });
	Object.defineProperty(own, "source", { get: () => iframe.contentWindow });
	window.dispatchEvent(own);
	expect(handleOpenUrl).toHaveBeenCalledWith("https://example.org");
	unmount();
});
