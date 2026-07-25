import { beforeEach, describe, expect, it } from "vitest";
import { fileIconRegistry } from "../../plugins/fileIconRegistry";
import type { FileIconProvider } from "../../plugins/types";

const iconProvider = (icon: string): FileIconProvider => ({
	resolveFileIcon: () => icon,
});

describe("fileIconRegistry", () => {
	beforeEach(() => {
		fileIconRegistry.clear();
	});

	describe("register / resolve", () => {
		it("returns null when nothing is registered", () => {
			expect(fileIconRegistry.resolve("index.ts", false)).toBeNull();
		});

		it("last registered provider wins", () => {
			fileIconRegistry.register(iconProvider("<a/>"));
			fileIconRegistry.register(iconProvider("<b/>"));
			expect(fileIconRegistry.resolve("index.ts", false)).toBe("<b/>");
		});

		it("returns null when the active provider throws", () => {
			fileIconRegistry.register({
				resolveFileIcon: () => {
					throw new Error("icon boom");
				},
			});

			expect(fileIconRegistry.resolve("index.ts", false)).toBeNull();
		});

		it("bumps version on register", () => {
			const before = fileIconRegistry.getVersion();
			fileIconRegistry.register(iconProvider("<a/>"));
			expect(fileIconRegistry.getVersion()).toBe(before + 1);
		});
	});

	describe("dispose", () => {
		it("disposing the active registration restores the previous one", () => {
			fileIconRegistry.register(iconProvider("<a/>"));
			const d = fileIconRegistry.register(iconProvider("<b/>"));
			d.dispose();
			expect(fileIconRegistry.resolve("index.ts", false)).toBe("<a/>");
		});

		it("bumps version on dispose", () => {
			const d = fileIconRegistry.register(iconProvider("<a/>"));
			const before = fileIconRegistry.getVersion();
			d.dispose();
			expect(fileIconRegistry.getVersion()).toBe(before + 1);
		});

		it("double dispose is a no-op (does not remove the wrong provider)", () => {
			const a = fileIconRegistry.register(iconProvider("<a/>"));
			fileIconRegistry.register(iconProvider("<b/>"));
			a.dispose();
			a.dispose();
			expect(fileIconRegistry.resolve("index.ts", false)).toBe("<b/>");
		});
	});

	// The bug this story fixes: with 3+ providers and out-of-order (non-LIFO)
	// disposal, the old single-slot design permanently lost the earlier
	// provider from the restore chain.
	describe("multi-register + out-of-order dispose", () => {
		it("disposing the middle registration keeps the active provider intact", () => {
			fileIconRegistry.register(iconProvider("<a/>"));
			const dB = fileIconRegistry.register(iconProvider("<b/>"));
			fileIconRegistry.register(iconProvider("<c/>"));

			// C is active; disposing the middle B must not affect the top.
			dB.dispose();
			expect(fileIconRegistry.resolve("index.ts", false)).toBe("<c/>");
		});

		it("disposing top then the previously-middle registration restores the base", () => {
			fileIconRegistry.register(iconProvider("<a/>"));
			const dB = fileIconRegistry.register(iconProvider("<b/>"));
			const dC = fileIconRegistry.register(iconProvider("<c/>"));

			dC.dispose(); // top gone -> B active
			expect(fileIconRegistry.resolve("index.ts", false)).toBe("<b/>");

			dB.dispose(); // now B gone -> A active
			expect(fileIconRegistry.resolve("index.ts", false)).toBe("<a/>");
		});

		it("disposing the base registration first still exposes the top, then chains down correctly", () => {
			const dA = fileIconRegistry.register(iconProvider("<a/>"));
			const dB = fileIconRegistry.register(iconProvider("<b/>"));
			const dC = fileIconRegistry.register(iconProvider("<c/>"));

			// Non-LIFO: dispose the earliest registration first.
			dA.dispose();
			expect(fileIconRegistry.resolve("index.ts", false)).toBe("<c/>");

			dC.dispose();
			// A is gone, C is gone -> B is the only survivor.
			expect(fileIconRegistry.resolve("index.ts", false)).toBe("<b/>");

			dB.dispose();
			expect(fileIconRegistry.resolve("index.ts", false)).toBeNull();
		});
	});
});
