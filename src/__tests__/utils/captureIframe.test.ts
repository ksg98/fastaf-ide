import { afterEach, describe, expect, it, vi } from "vitest";
import { captureIframeAsWebp } from "../../utils/captureIframe";

describe("captureIframeAsWebp", () => {
	afterEach(() => vi.restoreAllMocks());

	it("rejects URL-mode and inaccessible frames before allocating an object URL", async () => {
		const create = vi.spyOn(URL, "createObjectURL");
		const urlFrame = document.createElement("iframe");
		urlFrame.src = "https://example.test/frame";
		expect(await captureIframeAsWebp(urlFrame)).toBeNull();
		expect(create).not.toHaveBeenCalled();

		const inaccessible = { src: "", srcdoc: "", contentDocument: null } as unknown as HTMLIFrameElement;
		expect(await captureIframeAsWebp(inaccessible)).toBeNull();
	});

	it("returns null when canvas encoding is unavailable and always revokes the object URL", async () => {
		const frame = document.createElement("iframe");
		Object.defineProperty(frame, "contentDocument", { value: document.implementation.createHTMLDocument("frame") });
		Object.defineProperties(frame, { clientWidth: { value: 320 }, clientHeight: { value: 200 } });
		const revoke = vi.spyOn(URL, "revokeObjectURL");
		vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:frame");
		const image = {
			set src(_url: string) {
				queueMicrotask(() => this.onload?.());
			},
			onload: null as (() => void) | null,
			onerror: null,
		};
		vi.stubGlobal("Image", function ImageMock() {
			return image;
		});
		const context = { drawImage: vi.fn() } as unknown as CanvasRenderingContext2D;
		vi.spyOn(document, "createElement").mockImplementation(((tag: string) => {
			if (tag !== "canvas")
				return document.createElementNS("http://www.w3.org/1999/xhtml", tag) as unknown as HTMLElement;
			return {
				width: 0,
				height: 0,
				getContext: () => context,
				toBlob: (cb: BlobCallback) => cb(null),
			} as unknown as HTMLCanvasElement;
		}) as typeof document.createElement);

		expect(await captureIframeAsWebp(frame, 0.4)).toBeNull();
		expect(context.drawImage).toHaveBeenCalledWith(image, 0, 0, 320, 200);
		expect(revoke).toHaveBeenCalledWith("blob:frame");
	});

	it("returns null for a missing 2D context and still releases its temporary URL", async () => {
		const frame = document.createElement("iframe");
		Object.defineProperty(frame, "contentDocument", { value: document.implementation.createHTMLDocument("frame") });
		vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:no-context");
		const revoke = vi.spyOn(URL, "revokeObjectURL");
		const image = {
			set src(_url: string) {
				queueMicrotask(() => this.onload?.());
			},
			onload: null as (() => void) | null,
			onerror: null,
		};
		vi.stubGlobal("Image", function ImageMock() {
			return image;
		});
		const canvas = { width: 0, height: 0, getContext: () => null } as unknown as HTMLCanvasElement;
		vi.spyOn(document, "createElement").mockImplementation(((tag: string) =>
			tag === "canvas"
				? canvas
				: (document.createElementNS(
						"http://www.w3.org/1999/xhtml",
						tag,
					) as unknown as HTMLElement)) as typeof document.createElement);

		expect(await captureIframeAsWebp(frame)).toBeNull();
		expect(revoke).toHaveBeenCalledWith("blob:no-context");
	});

	it("revokes the URL when SVG image decoding fails", async () => {
		const frame = document.createElement("iframe");
		Object.defineProperty(frame, "contentDocument", { value: document.implementation.createHTMLDocument("frame") });
		vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:broken");
		const revoke = vi.spyOn(URL, "revokeObjectURL");
		const image = {
			set src(_url: string) {
				queueMicrotask(() => this.onerror?.());
			},
			onload: null,
			onerror: null as (() => void) | null,
		};
		vi.stubGlobal("Image", function ImageMock() {
			return image;
		});

		await expect(captureIframeAsWebp(frame)).rejects.toThrow("SVG foreignObject render failed");
		expect(revoke).toHaveBeenCalledWith("blob:broken");
	});

	it("encodes a decoded same-origin frame and preserves the requested quality", async () => {
		const frame = document.createElement("iframe");
		Object.defineProperty(frame, "contentDocument", { value: document.implementation.createHTMLDocument("frame") });
		vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:ok");
		const revoke = vi.spyOn(URL, "revokeObjectURL");
		const image = {
			set src(_url: string) {
				queueMicrotask(() => this.onload?.());
			},
			onload: null as (() => void) | null,
			onerror: null,
		};
		vi.stubGlobal("Image", function ImageMock() {
			return image;
		});
		const toBlob = vi.fn((callback: BlobCallback, type?: string) =>
			callback(new Blob([new Uint8Array([65, 66])], { type })),
		);
		const canvas = {
			width: 0,
			height: 0,
			getContext: () => ({ drawImage: vi.fn() }),
			toBlob,
		} as unknown as HTMLCanvasElement;
		vi.spyOn(document, "createElement").mockImplementation(((tag: string) =>
			tag === "canvas"
				? canvas
				: (document.createElementNS(
						"http://www.w3.org/1999/xhtml",
						tag,
					) as unknown as HTMLElement)) as typeof document.createElement);

		expect(await captureIframeAsWebp(frame, 0.25)).toBe("QUI=");
		expect(toBlob).toHaveBeenCalledWith(expect.any(Function), "image/webp", 0.25);
		expect(revoke).toHaveBeenCalledWith("blob:ok");
	});
});
