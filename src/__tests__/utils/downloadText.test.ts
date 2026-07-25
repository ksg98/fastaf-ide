import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { downloadText } from "../../utils/downloadText";

describe("downloadText", () => {
	let createObjectURL: ReturnType<typeof vi.fn>;
	let revokeObjectURL: ReturnType<typeof vi.fn>;
	let click: ReturnType<typeof vi.fn>;
	let anchor: HTMLAnchorElement;
	let originalCreateElement: typeof document.createElement;

	beforeEach(() => {
		createObjectURL = vi.fn(() => "blob:mock-url");
		revokeObjectURL = vi.fn();
		// jsdom doesn't implement the object URL API — stub it.
		(URL as unknown as { createObjectURL: unknown }).createObjectURL = createObjectURL;
		(URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = revokeObjectURL;

		click = vi.fn();
		originalCreateElement = document.createElement.bind(document);
		vi.spyOn(document, "createElement").mockImplementation((tag: string) => {
			const el = originalCreateElement(tag) as HTMLElement;
			if (tag === "a") {
				anchor = el as HTMLAnchorElement;
				anchor.click = click as unknown as () => void;
			}
			return el;
		});
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("creates an anchor with the right download filename and href, then revokes the URL", () => {
		downloadText("CHANGELOG-ai.md", "## Hello\n- world");

		const blobArg = createObjectURL.mock.calls[0][0] as Blob;
		expect(blobArg).toBeInstanceOf(Blob);
		expect(blobArg.type).toContain("text/plain");

		expect(anchor.download).toBe("CHANGELOG-ai.md");
		expect(anchor.getAttribute("href")).toBe("blob:mock-url");
		expect(click).toHaveBeenCalledOnce();
		expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock-url");
	});
});
