import { render } from "@solidjs/testing-library";
import { describe, expect, it, vi } from "vitest";
import { ContentRenderer } from "../../components/ui/ContentRenderer";

vi.mock("../../utils/openUrl", () => ({ handleOpenUrl: vi.fn() }));

function imgSrc(container: HTMLElement): string | null {
	return container.querySelector("img")?.getAttribute("src") ?? null;
}

describe("ContentRenderer local images (critic 1335)", () => {
	// Catches: the absolute-path branch runs before imageSrc, so mobile (1215) repo images
	// stop going through the caller's resolver.
	it("hands an absolute path to imageSrc when one is supplied", () => {
		const imageSrc = vi.fn((p: string) => `https://mobile.example/raw?p=${p}`);
		const { container } = render(() => (
			<ContentRenderer content="![x](/abs/pic.png)" baseDir="/repo" imageSrc={imageSrc} />
		));
		expect(imageSrc).toHaveBeenCalledWith("/abs/pic.png");
		expect(imgSrc(container)).toBe("https://mobile.example/raw?p=/abs/pic.png");
	});

	// Catches: Windows drive paths are treated as relative and glued onto baseDir.
	it("does not prefix baseDir to a Windows drive path", () => {
		const { container } = render(() => <ContentRenderer content="![x](C:/Users/me/pic.png)" baseDir="C:/repo" />);
		const src = imgSrc(container);
		expect(src).toContain("C:/Users/me/pic.png");
		expect(src).not.toContain("repo");
	});

	// Catches: a relative path with a sub-directory loses the baseDir join.
	it("still joins a relative path onto baseDir", () => {
		const { container } = render(() => <ContentRenderer content="![x](sub/a.png)" baseDir="/repo/docs" />);
		expect(imgSrc(container)).toBe("asset://localhost/repo/docs/sub/a.png");
	});

	// Catches: a protocol-relative remote URL (//host/x.png) is classified as an absolute
	// local path and mapped to a bogus asset:// read.
	it("leaves a protocol-relative URL out of the asset protocol", () => {
		const { container } = render(() => <ContentRenderer content="![x](//cdn.example.com/x.png)" baseDir="/repo" />);
		expect(imgSrc(container)).not.toContain("asset://");
	});
});
