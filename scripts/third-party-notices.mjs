#!/usr/bin/env node
// Regenerates the dependency tables and the License Summary of
// THIRD_PARTY_NOTICES.md from Cargo.lock (via `cargo metadata`) and the
// installed pnpm packages, so a direct dependency cannot ship without a row.
//
//   node scripts/third-party-notices.mjs               rewrite the file
//   node scripts/third-party-notices.mjs --check       fail if the file is stale
//   node scripts/third-party-notices.mjs --only rust   restrict to one ecosystem
//   node scripts/third-party-notices.mjs --self-test
//
// `--only rust` needs only cargo, `--only js` only `pnpm install`: CI checks each
// where its toolchain already exists. The summary spans both, so it is part of
// the full run only.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NOTICES = join(ROOT, "THIRD_PARTY_NOTICES.md");
const BLOCKS = ["rust", "rust-platform", "rust-dev", "js", "js-dev", "summary"];

/** Crates whose manifest names no license. The license text ships with the source. */
const LICENSE_OVERRIDES = {
	// src-tauri/patches/webrtc-audio-processing-sys/COPYING is the WebRTC BSD-3-Clause text.
	"webrtc-audio-processing": "BSD-3-Clause",
};

/** `MIT/Apache-2.0` and `Apache-2.0 OR MIT` are the same license. */
export function normalizeLicense(raw) {
	const text = (raw ?? "").trim();
	if (!text) return "UNKNOWN";
	return text.replace(/\s*\/\s*/g, " OR ").replace(/[()]/g, "").replace(/\s+/g, " ");
}

function licenseKey(license) {
	return license
		.split(" OR ")
		.map((part) => part.trim())
		.sort()
		.join(" OR ");
}

function platformOf(target) {
	const parts = [];
	if (/target_os\s*=\s*"macos"/.test(target)) parts.push("macOS");
	if (/windows/.test(target)) parts.push("Windows");
	if (/target_os\s*=\s*"linux"/.test(target) || /unix/.test(target)) parts.push("Linux");
	return parts.length ? parts.join(", ") : target;
}

/** Direct dependencies of every workspace crate, resolved by Cargo.lock, in three groups. */
export function collectRust(meta) {
	const byId = new Map(meta.packages.map((pkg) => [pkg.id, pkg]));
	const members = new Set(meta.workspace_members);
	const rank = { rust: 0, "rust-platform": 1, "rust-dev": 2 };
	const best = new Map();
	for (const node of meta.resolve.nodes) {
		if (!members.has(node.id)) continue;
		for (const dep of node.deps) {
			const pkg = byId.get(dep.pkg);
			if (!pkg || pkg.source === null) continue; // workspace path crates
			const row = {
				name: pkg.name,
				version: pkg.version,
				license: normalizeLicense(LICENSE_OVERRIDES[pkg.name] ?? pkg.license),
			};
			const kinds = dep.dep_kinds;
			const platform = kinds.find((kind) => kind.kind !== "dev" && kind.target !== null);
			let group = "rust-dev";
			if (kinds.some((kind) => kind.kind !== "dev" && kind.target === null)) group = "rust";
			else if (platform) {
				group = "rust-platform";
				row.platform = platformOf(platform.target);
			}
			const key = `${row.name} ${row.version}`;
			if (!best.has(key) || rank[group] < rank[best.get(key).group]) best.set(key, { group, row });
		}
	}
	const groups = { rust: [], "rust-platform": [], "rust-dev": [] };
	for (const { group, row } of best.values()) groups[group].push(row);
	return groups;
}

/** Direct dependencies of package.json at the installed versions. */
export function collectJs(manifest, readInstalled) {
	const groups = { js: [], "js-dev": [] };
	const pairs = [
		["js", manifest.dependencies ?? {}],
		["js-dev", manifest.devDependencies ?? {}],
	];
	for (const [group, deps] of pairs) {
		for (const name of Object.keys(deps)) {
			const installed = readInstalled(name);
			if (!installed) throw new Error(`${name} is not installed; run pnpm install`);
			const license = typeof installed.license === "string" ? installed.license : installed.license?.type;
			groups[group].push({ name, version: installed.version, license: normalizeLicense(license) });
		}
	}
	return groups;
}

const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

function table(rows, head) {
	const platform = head === "rust-platform";
	const label = head.startsWith("js") ? "Package" : "Crate";
	const lines = [
		`| ${label} | Version | License${platform ? " | Platform" : ""} |`,
		`|${"-".repeat(label.length + 2)}|---------|---------${platform ? "|----------" : ""}|`,
	];
	for (const row of [...rows].sort(byName)) {
		lines.push(`| ${row.name} | ${row.version} | ${row.license}${platform ? ` | ${row.platform}` : ""} |`);
	}
	return lines.join("\n");
}

export function summary(groups) {
	const counts = new Map();
	for (const rows of Object.values(groups)) {
		for (const row of rows) {
			const key = licenseKey(row.license);
			const entry = counts.get(key) ?? { display: row.license, count: 0 };
			entry.count += 1;
			counts.set(key, entry);
		}
	}
	const sorted = [...counts.values()].sort((a, b) => b.count - a.count || (a.display < b.display ? -1 : 1));
	return ["| License | Count |", "|---------|-------|", ...sorted.map((entry) => `| ${entry.display} | ${entry.count} |`)].join(
		"\n",
	);
}

const marker = (kind, name) => `<!-- ${kind} GENERATED:${name} -->`;

/** Replaces the generated blocks present in `groups`; every other byte is kept. */
export function render(text, groups, blocks) {
	for (const row of Object.values(groups).flat()) {
		if (row.license === "UNKNOWN") throw new Error(`${row.name} declares no license; add it to LICENSE_OVERRIDES`);
	}
	let out = text;
	for (const name of blocks) {
		const begin = marker("BEGIN", name);
		const end = marker("END", name);
		const start = out.indexOf(begin);
		const stop = out.indexOf(end);
		if (start < 0 || stop < start) throw new Error(`THIRD_PARTY_NOTICES.md lacks the ${name} block markers`);
		const body = name === "summary" ? summary(groups) : table(groups[name], name);
		out = `${out.slice(0, start + begin.length)}\n${body}\n${out.slice(stop)}`;
	}
	return out;
}

function loadRust() {
	const raw = execFileSync("cargo", ["metadata", "--format-version", "1", "--locked", "--all-features"], {
		cwd: join(ROOT, "src-tauri"),
		maxBuffer: 1 << 28,
		encoding: "utf8",
	});
	return collectRust(JSON.parse(raw));
}

function loadJs() {
	const manifest = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
	return collectJs(manifest, (name) => {
		const path = join(ROOT, "node_modules", name, "package.json");
		return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
	});
}

function selfTest() {
	const assert = (cond, message) => {
		if (!cond) throw new Error(`self-test: ${message}`);
	};
	assert(normalizeLicense("MIT/Apache-2.0") === "MIT OR Apache-2.0", "slash is OR");
	assert(licenseKey("MIT OR Apache-2.0") === licenseKey("Apache-2.0 OR MIT"), "OR order does not matter");
	const pkg = (name, license, source = "registry+x") => ({ id: name, name, version: "1.0.0", license, source });
	const dep = (name, kind, target = null) => ({ pkg: name, dep_kinds: [{ kind, target }] });
	const meta = {
		packages: [pkg("a", "MIT"), pkg("b", "MIT"), pkg("c", "MIT"), pkg("path-crate", "MIT", null), pkg("d", "Zlib")],
		workspace_members: ["root"],
		resolve: {
			nodes: [
				{
					id: "root",
					deps: [
						dep("a", null),
						dep("b", null, 'cfg(target_os = "macos")'),
						dep("c", "dev"),
						dep("path-crate", null),
						dep("d", "build"),
					],
				},
			],
		},
	};
	const rust = collectRust(meta);
	assert(rust.rust.map((r) => r.name).join() === "a,d", "normal and build deps are main");
	assert(rust["rust-platform"][0]?.platform === "macOS", "target-gated dep keeps its platform");
	assert(rust["rust-dev"][0]?.name === "c", "dev dep is separate");
	const template = `x\n${marker("BEGIN", "rust")}\nold\n${marker("END", "rust")}\ny\n`;
	const once = render(template, rust, ["rust"]);
	assert(once.includes("| a | 1.0.0 | MIT |") && !once.includes("old"), "rows replace the block");
	assert(!once.includes("path-crate"), "workspace crates have no row");
	assert(render(once, rust, ["rust"]) === once, "rendering is idempotent");
	// A new direct dependency with no row must make --check fail.
	meta.packages.push(pkg("new-dep", "MIT"));
	meta.resolve.nodes[0].deps.push(dep("new-dep", null));
	assert(render(once, collectRust(meta), ["rust"]) !== once, "a missing row changes the output");
	console.log("third-party-notices self-test ok");
}

function main(argv) {
	if (argv.includes("--self-test")) return selfTest();
	const only = argv.includes("--only") ? argv[argv.indexOf("--only") + 1] : "all";
	if (!["all", "rust", "js"].includes(only)) throw new Error("--only takes rust or js");
	const groups = {};
	if (only !== "js") Object.assign(groups, loadRust());
	if (only !== "rust") Object.assign(groups, loadJs());
	const blocks = only === "all" ? BLOCKS : BLOCKS.filter((name) => name.startsWith(only) && name in groups);
	const current = readFileSync(NOTICES, "utf8");
	const next = render(current, groups, blocks);
	if (argv.includes("--check")) {
		if (next !== current) {
			console.error("THIRD_PARTY_NOTICES.md is stale: run `node scripts/third-party-notices.mjs`.");
			process.exit(1);
		}
		console.log("THIRD_PARTY_NOTICES.md is up to date");
		return;
	}
	writeFileSync(NOTICES, next);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2));
