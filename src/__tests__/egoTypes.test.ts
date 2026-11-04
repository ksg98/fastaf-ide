import { describe, expect, it } from "vitest";
import { HttpRpcError } from "../transport";
import { asEgoCliError } from "../types/ego";

const ego = { code: "launchFailed", message: "no such file", command: "", stdout: "", stderr: "", exitCode: null };

describe("asEgoCliError", () => {
	// Catches: the HTTP body being read as the error itself instead of parsed JSON.
	it("unwraps the ego error an HttpRpcError carries", () => {
		expect(asEgoCliError(new HttpRpcError("ego_providers", 424, JSON.stringify(ego)))).toEqual(ego);
	});

	it("passes a desktop rejection through unchanged", () => {
		expect(asEgoCliError(ego)).toBe(ego);
	});

	// Catches: any thrown value with a `body` being dressed up as an ego refusal.
	it.each([
		["null", null],
		["undefined", undefined],
		["a string", "boom"],
		["a plain Error", new Error("boom")],
		["a non-string body", { body: 5 }],
		["truncated JSON", { body: '{"code":"launchFailed","mess' }],
		["JSON without code", new HttpRpcError("x", 500, '{"error":"boom"}')],
		["a non-string message", new HttpRpcError("x", 500, '{"code":"notConfigured","message":7}')],
		["a JSON array", new HttpRpcError("x", 500, "[1,2]")],
	])("returns null for %s", (_name, value) => {
		expect(asEgoCliError(value)).toBeNull();
	});
});
