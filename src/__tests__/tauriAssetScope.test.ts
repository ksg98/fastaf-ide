import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const conf = JSON.parse(readFileSync(resolve(__dirname, "../../src-tauri/tauri.conf.json"), "utf-8"));
const scope: unknown = conf.app.security.assetProtocol.scope;

describe("tauri.conf.json assetProtocol scope", () => {
	// Tauri's Unix default (requireLiteralLeadingDot=true) makes `/**` skip dot-directories.
	// Catches: someone turning the default off (object form with requireLiteralLeadingDot:false),
	// which would expose $HOME/.ssh, .aws, .claude* to every webview page.
	it("keeps the dot-directory default: plain allow list, no requireLiteralLeadingDot override", () => {
		expect(Array.isArray(scope)).toBe(true);
	});

	// Real glob matching (~/Gits/.tmp served, other dot paths denied) is covered by
	// src-tauri/tests/asset_scope_glob.rs.

	// Catches: a broad dot-directory allow slipping in next to the .tmp one.
	it("names no other dot-directory (so $HOME/.ssh stays out of scope)", () => {
		const dotEntries = (scope as string[]).filter((p) => p.split("/").some((seg) => seg.startsWith(".")));
		expect(dotEntries).toEqual(["$HOME/Gits/**/.tmp/**"]);
	});
});
