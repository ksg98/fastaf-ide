import { describe, expect, it, vi } from "vitest";
import {
	getRemoteBaseUrl,
	previewLogPayload,
	setRemoteBaseUrlLookup,
	setTransportLogger,
	transportLogger,
} from "../transportRuntime";

describe("transport runtime ports", () => {
	it("uses injected logging and remote connection lookup without store imports", () => {
		const debug = vi.fn();
		const warn = vi.fn();
		setTransportLogger({ debug, warn });
		setRemoteBaseUrlLookup((id) => (id === "connected" ? "http://remote.test" : undefined));

		transportLogger().debug("network", "connected");
		expect(debug).toHaveBeenCalledWith("network", "connected");
		expect(getRemoteBaseUrl("connected")).toBe("http://remote.test");
		expect(getRemoteBaseUrl("missing")).toBeUndefined();
	});

	it("bounds malformed payload previews", () => {
		expect(previewLogPayload("short")).toBe("short");
		expect(previewLogPayload("x".repeat(501))).toBe(`${"x".repeat(500)}...`);
	});
});
