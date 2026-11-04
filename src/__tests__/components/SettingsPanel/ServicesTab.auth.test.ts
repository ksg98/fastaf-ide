import { describe, expect, it } from "vitest";
import {
	DEFAULT_AUTH_USERNAME,
	normalizeAuthUsername,
} from "../../../components/SettingsPanel/tabs/services/RemoteAccessPanel";

describe("remote access username normalization", () => {
	it("keeps a real username untouched apart from surrounding blanks", () => {
		expect(normalizeAuthUsername("boss")).toBe("boss");
		expect(normalizeAuthUsername("  boss  ")).toBe("boss");
	});

	it.each(["", "   ", "\t\n"])("substitutes the advertised default for %j", (input) => {
		// An empty username makes the backend report NotConfigured, which answers
		// every Basic Auth attempt with 401 — the phone can never log in.
		expect(normalizeAuthUsername(input)).toBe(DEFAULT_AUTH_USERNAME);
	});
});
