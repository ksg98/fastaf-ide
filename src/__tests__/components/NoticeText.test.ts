import { describe, expect, it } from "vitest";
import { splitNotice } from "../../components/AIChatPanel/NoticeText";

describe("splitNotice", () => {
	it("keeps a one-line notice whole", () => {
		expect(splitNotice("  Context was trimmed.  ")).toEqual({ head: "Context was trimmed.", rest: "" });
	});

	it("splits a long notice at its first line and keeps the rest's own line breaks", () => {
		expect(splitNotice("HTTP 401\n\n{json}\nCheck the key.\n")).toEqual({
			head: "HTTP 401",
			rest: "{json}\nCheck the key.",
		});
	});
});
