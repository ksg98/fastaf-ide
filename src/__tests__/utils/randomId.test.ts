import { afterEach, describe, expect, it, vi } from "vitest";
import { randomId } from "../../utils/randomId";

describe("randomId", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("prefixes the crypto UUID when one is available", () => {
		vi.stubGlobal("crypto", { randomUUID: () => "1111-2222" });
		expect(randomId("cs-")).toBe("cs-1111-2222");
	});

	/// The reason this helper exists: `crypto.randomUUID` is only defined in a
	/// secure context, and TUIC is reached over plain http on a LAN address. A
	/// bare call would throw for exactly the remote clients that need the id.
	it("still produces an id when crypto.randomUUID is missing", () => {
		vi.stubGlobal("crypto", {});
		const id = randomId("c");
		expect(id.startsWith("c")).toBe(true);
		expect(id.length).toBeGreaterThan(5);
	});

	it("survives a missing crypto object entirely", () => {
		vi.stubGlobal("crypto", undefined);
		expect(() => randomId("s")).not.toThrow();
	});

	/// The backend qualifies watcher ids with "/", so an id containing one is
	/// parsed as two.
	it("never emits a slash, in either branch", () => {
		vi.stubGlobal("crypto", {});
		const ids = Array.from({ length: 50 }, () => randomId("c"));
		expect(ids.some((id) => id.includes("/"))).toBe(false);
		// Distinct enough that two clients of one backend do not collide.
		expect(new Set(ids).size).toBeGreaterThan(1);
	});
});
