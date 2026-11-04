// @vitest-environment jsdom
import { cleanup, render } from "@solidjs/testing-library";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContentRenderer } from "../../components/ui/ContentRenderer";
import { repositoriesStore } from "../../stores/repositories";

vi.mock("../../transport", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../transport")>()),
	isTauri: () => false,
}));
vi.mock("../../invoke", () => ({
	invoke: vi.fn().mockResolvedValue(undefined),
	listen: vi.fn().mockResolvedValue(() => {}),
}));
vi.mock("../../utils/openUrl", () => ({ handleOpenUrl: vi.fn() }));

describe("browser Markdown image filenames", () => {
	beforeEach(() => {
		repositoriesStore.add({ path: "/repo", displayName: "Repo" });
	});

	afterEach(() => {
		cleanup();
		repositoriesStore._testCancelPendingSave();
	});

	// Catches: treating a serialized HTML/URL path as the literal filesystem filename.
	it.each([
		["![chart](charts/my%20chart.png)", "docs/charts/my chart.png"],
		["![chart](charts/profit&loss.png)", "docs/charts/profit&loss.png"],
	])("requests the actual repository filename for %s", (markdown, filename) => {
		const { container } = render(() => <ContentRenderer content={markdown} baseDir="/repo/docs" />);
		const image = container.querySelector("img");
		expect(image).not.toBeNull();
		const url = new URL(image!.src);
		expect(url.pathname).toBe("/fs/markdown-image");
		expect(url.searchParams.get("repoPath")).toBe("/repo");
		expect(url.searchParams.get("file")).toBe(filename);
	});
});
