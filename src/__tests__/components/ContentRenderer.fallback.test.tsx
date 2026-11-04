// @vitest-environment jsdom

import { render } from "@solidjs/testing-library";
import { marked } from "marked";
import { describe, expect, it, vi } from "vitest";
import { ContentRenderer } from "../../components/ui/ContentRenderer";
import { appLogger } from "../../stores/appLogger";

describe("ContentRenderer parser failure", () => {
	// Catches: parser errors bypassing sanitization and inserting raw source as live HTML.
	it.each([false, true])("escapes fallback HTML instead of injecting live elements (incremental=%s)", (incremental) => {
		const source = "<img src=x onerror=alert(1)> &lt;literal&gt; </pre><script>alert(1)</script>";
		const failure = new Error("parser failure");
		const parser = vi.spyOn(marked, "parse").mockImplementation(() => {
			throw failure;
		});
		const logger = vi.spyOn(appLogger, "error").mockImplementation(() => {});
		try {
			const { container } = render(() => <ContentRenderer content={source} incremental={incremental} />);
			expect(container.querySelector("img,script")).toBeNull();
			expect(container.querySelector("pre")?.textContent).toBe(source);
			expect(logger).toHaveBeenCalledWith("app", "Markdown parsing error", failure);
		} finally {
			parser.mockRestore();
			logger.mockRestore();
		}
	});
});
