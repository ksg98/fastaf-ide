import { describe, expect, it } from "vitest";
import { injectThemeVars } from "../PluginPanel";

describe("injectThemeVars base-sheet scoping (#080)", () => {
	it("does NOT inject the tuic-base sheet for self-styled (design/preview) tabs", () => {
		const out = injectThemeVars(
			"<html><head><style>body{background:#fff;color:#000;font-size:20px}</style></head><body>hi</body></html>",
			true,
		);
		expect(out).not.toContain('id="tuic-base"');
		// The document's own style is preserved untouched.
		expect(out).toContain("background:#fff");
	});

	it("injects the tuic-base sheet for plugin dashboards even when they ship their own <style>", () => {
		// Regression: a dashboard shipping supplementary layout styles still relies
		// on PLUGIN_BASE_CSS for typography/theme. Source (selfStyled=false), not
		// content sniffing, decides — so the base sheet must be present.
		const out = injectThemeVars(
			'<html><head><style>.col{border-top:2px solid red}</style></head><body><div class="dashboard">x</div></body></html>',
			false,
		);
		expect(out).toContain('id="tuic-base"');
		// The dashboard's own supplementary style is preserved alongside the base.
		expect(out).toContain("border-top:2px solid red");
	});

	it("injects the tuic-base sheet for plain unstyled plugin dashboards", () => {
		const out = injectThemeVars('<html><head></head><body><div class="dashboard">x</div></body></html>', false);
		expect(out).toContain('id="tuic-base"');
	});

	it("still injects the SDK script in both branches", () => {
		const selfStyled = injectThemeVars("<style>a{}</style><body>x</body>", true);
		const dashboard = injectThemeVars("<body>x</body>", false);
		expect(selfStyled).toContain('id="tuic-sdk"');
		expect(dashboard).toContain('id="tuic-sdk"');
	});
});
