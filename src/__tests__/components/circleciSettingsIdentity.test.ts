import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { settingsCatalogue } from "../../generated/settingsCatalogue";

// Catches: UI credential identity drifting away from the Rust-owned write-only setting.
describe("CircleCI Settings identity", () => {
	it("binds the existing password control to the owner descriptor without a secret default", () => {
		const field = settingsCatalogue.fields["circleci.token"];
		const source = readFileSync(join(__dirname, "../../components/SettingsPanel/tabs/GitHubTab.tsx"), "utf8");
		expect(source).toContain(`data-setting-id="${field.id}"`);
		expect(source).toContain('aria-label="CircleCI read-only token"');
		expect(field.store).toBe("circleci");
		expect(field.path).toBe("/token");
		expect(field.schema.writeOnly).toBe(true);
		expect(field.sensitivity).toBe("secret");
		expect(field.operations).toEqual(["get", "set_secret", "clear_secret"]);
		expect(field).not.toHaveProperty("default");
	});
});
