import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("remote_terminal_websocket_schemes_are_explicitly_allowed", () => {
	// Catches #147: HTTP(S) sources alone leave remote WS(S) streams blocked
	// in WebKit. SSH uses a dynamic loopback port; Direct accepts user-owned
	// HTTP or HTTPS hosts/ports, so neither scheme can be loopback-only.
	const {
		app: { security },
	} = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
	const directives = security.csp.split(";").map((value: string) => value.trim().split(/\s+/));
	const sources = (
		directives.find(([name]: string[]) => name === "connect-src") ??
		directives.find(([name]: string[]) => name === "default-src")
	)?.slice(1);
	expect(sources, "connect-src (or default-src fallback) must explicitly allow remote WebSocket schemes").toEqual(
		expect.arrayContaining(["ws:", "wss:"]),
	);
});

it("csp_must_stay_wide_open_boss_decision", () => {
	// AGENTS.md, Accepted Security Decisions: the user is the trust boundary.
	// Per-directive restrictions blank URL tabs and break plugin scripts/styles.
	// CI: .github/workflows/csp-policy.yml, "Guard permissive CSP" (every push/PR).
	// Also collected by ci.yml, frontend job, "Tests".
	const {
		app: { security },
	} = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
	const directives = security.csp
		.split(";")
		.map((value: string) => value.trim())
		.filter(Boolean);
	expect(
		directives.map((value: string) => value.split(/\s+/)[0]),
		"AGENTS.md forbids every per-directive CSP restriction, including frame-src",
	).toEqual(["default-src"]);
	const sources = directives[0].split(/\s+/).slice(1);
	expect(sources, "AGENTS.md requires a permissive default-src").toEqual(
		expect.arrayContaining([
			"'self'",
			"'unsafe-inline'",
			"https:",
			"http:",
			"data:",
			"blob:",
			"asset:",
			"http://asset.localhost",
			"ipc:",
			"tauri:",
			"plugin:",
		]),
	);
	expect(
		security.dangerousDisableAssetCspModification,
		"AGENTS.md requires disabling Tauri script/style CSP hash injection",
	).toEqual(expect.arrayContaining(["style-src", "script-src"]));
});
