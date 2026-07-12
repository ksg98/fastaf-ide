import { afterEach, describe, expect, it, vi } from "vitest";
import { filePreviewRegistry } from "../plugins/filePreviewRegistry";

describe("filePreviewRegistry", () => {
	afterEach(() => {
		filePreviewRegistry.clear();
	});

	it("returns undefined when no handler is registered", () => {
		expect(filePreviewRegistry.getHandler("foo.csv")).toBeUndefined();
	});

	it("registers a handler and retrieves it by extension", () => {
		const handler = vi.fn();
		filePreviewRegistry.register("test-plugin", ["csv"], handler);

		const result = filePreviewRegistry.getHandler("data.csv");
		expect(result).toBeDefined();
		expect(result!.pluginId).toBe("test-plugin");
	});

	it("matches extensions case-insensitively", () => {
		const handler = vi.fn();
		filePreviewRegistry.register("test-plugin", ["CSV"], handler);

		expect(filePreviewRegistry.getHandler("data.csv")).toBeDefined();
		expect(filePreviewRegistry.getHandler("DATA.CSV")).toBeDefined();
	});

	it("registers multiple extensions at once", () => {
		const handler = vi.fn();
		filePreviewRegistry.register("test-plugin", ["csv", "tsv"], handler);

		expect(filePreviewRegistry.getHandler("a.csv")).toBeDefined();
		expect(filePreviewRegistry.getHandler("b.tsv")).toBeDefined();
	});

	it("returns undefined for files with no extension", () => {
		const handler = vi.fn();
		filePreviewRegistry.register("test-plugin", ["csv"], handler);

		expect(filePreviewRegistry.getHandler("Makefile")).toBeUndefined();
	});

	it("dispose removes the handler", () => {
		const handler = vi.fn();
		const disposable = filePreviewRegistry.register("test-plugin", ["csv"], handler);

		expect(filePreviewRegistry.getHandler("x.csv")).toBeDefined();
		disposable.dispose();
		expect(filePreviewRegistry.getHandler("x.csv")).toBeUndefined();
	});

	it("dispose only removes entries owned by the same plugin", () => {
		const handler1 = vi.fn();
		const handler2 = vi.fn();
		filePreviewRegistry.register("plugin-a", ["csv"], handler1);
		const d2 = filePreviewRegistry.register("plugin-b", ["tsv"], handler2);

		d2.dispose();
		expect(filePreviewRegistry.getHandler("x.csv")).toBeDefined();
		expect(filePreviewRegistry.getHandler("x.tsv")).toBeUndefined();
	});

	it("last registration wins for the same extension", () => {
		const handler1 = vi.fn();
		const handler2 = vi.fn();
		filePreviewRegistry.register("plugin-a", ["csv"], handler1);
		filePreviewRegistry.register("plugin-b", ["csv"], handler2);

		const result = filePreviewRegistry.getHandler("x.csv");
		expect(result!.pluginId).toBe("plugin-b");
	});

	it("dispose does not remove if another plugin re-claimed the extension", () => {
		const handler1 = vi.fn();
		const handler2 = vi.fn();
		const d1 = filePreviewRegistry.register("plugin-a", ["csv"], handler1);
		filePreviewRegistry.register("plugin-b", ["csv"], handler2);

		d1.dispose();
		const result = filePreviewRegistry.getHandler("x.csv");
		expect(result).toBeDefined();
		expect(result!.pluginId).toBe("plugin-b");
	});
});
