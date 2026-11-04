import { render } from "@solidjs/testing-library";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HtmlPreviewTab } from "../../components/HtmlPreviewTab/HtmlPreviewTab";
import type { HtmlPreviewTab as HtmlPreviewTabData } from "../../stores/mdTabs";
import { repositoriesStore } from "../../stores/repositories";
import { classifyFile, isImageFile } from "../../utils/filePreview";

const env = vi.hoisted(() => ({ tauri: true }));

vi.mock("@tauri-apps/api/core", () => ({
	convertFileSrc: (p: string) => `asset://localhost${p}`,
	invoke: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../../transport", async (orig) => ({ ...(await orig<object>()), isTauri: () => env.tauri }));
vi.mock("../../hooks/useRepository", () => ({ useRepository: () => ({ readFile: vi.fn() }) }));
vi.mock("../../utils/openUrl", () => ({ handleOpenUrl: vi.fn(), openLocalPath: vi.fn() }));

const FORMATS = ["png", "jpg", "webp"] as const;

function imageTab(repoPath: string, filePath: string): HtmlPreviewTabData {
	return {
		id: "img",
		type: "html-preview",
		repoPath,
		filePath,
		fileName: filePath.split("/").pop(),
	} as HtmlPreviewTabData;
}

function renderedSrc(tab: HtmlPreviewTabData): string | null {
	const { container } = render(() => <HtmlPreviewTab tab={tab} />);
	return container.querySelector("img")?.getAttribute("src") ?? null;
}

afterEach(() => {
	env.tauri = true;
	repositoriesStore._testCancelPendingSave();
	document.body.innerHTML = "";
});

describe("image files open as images (1335)", () => {
	// Catches: an image extension missing from the open-target set, so the file falls into the text editor.
	it.each(FORMATS)("classifies .%s as a previewed image", (ext) => {
		expect(isImageFile(`/x/shot.${ext}`)).toBe(true);
		expect(classifyFile(`/x/shot.${ext}`)).toBe("preview");
	});

	describe("desktop asset protocol", () => {
		// Catches: the preview tab's own extension list drifting from the open-target list (image rendered as text).
		it.each(FORMATS)("serves a repository .%s through the asset URL of its absolute path", (ext) => {
			expect(renderedSrc(imageTab("/repo", `docs/shot.${ext}`))).toBe(`asset://localhost/repo/docs/shot.${ext}?v=0`);
		});

		it.each(FORMATS)("serves a .%s outside any repository through the asset URL of its path", (ext) => {
			expect(renderedSrc(imageTab("", `/Users/boss/Gits/.tmp/shot.${ext}`))).toBe(
				`asset://localhost/Users/boss/Gits/.tmp/shot.${ext}?v=0`,
			);
		});
	});

	describe("browser mode", () => {
		// Catches: the shimmed convertFileSrc returning the bare path, which the page origin resolves to a 404.
		it.each(FORMATS)("serves a repository .%s through the HTTP image route", (ext) => {
			repositoriesStore.add({ path: "/repo", displayName: "Repo" });
			env.tauri = false;
			const src = renderedSrc(imageTab("/repo", `docs/shot.${ext}`));
			const url = new URL(src!);
			expect(url.pathname).toBe("/fs/markdown-image");
			expect(url.searchParams.get("repoPath")).toBe("/repo");
			expect(url.searchParams.get("file")).toBe(`docs/shot.${ext}`);
		});
	});
});
