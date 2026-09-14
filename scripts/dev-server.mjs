#!/usr/bin/env node
// Launcher behind `pnpm dev` (Tauri's `beforeDevCommand`).
//
// Vite is pinned to port 1421 with `strictPort` because Tauri's `devUrl` is a
// fixed URL. A second `pnpm dev` therefore died with `[ELIFECYCLE] exit 1` —
// and, worse, before failing to bind it ran its "re-optimizing dependencies"
// pass, which wipes the shared `node_modules/.vite/deps` cache. The server
// already running kept serving, minus its pre-bundled deps: every dep import
// 404s and hot reload is dead until a restart.
//
// So: never boot a second Vite. If the port already holds OUR dev server (same
// project root, reported by the `/__tuic_dev_root` endpoint registered in
// vite.config.ts), reuse it and exit 0 — Tauri attaches to it. If it holds
// anything else (another worktree, a stray process), fail loudly instead of
// silently serving the wrong sources.

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const PORT = 1421; // keep in sync with vite.config.ts `server.port`
const HOST = process.env.TAURI_DEV_HOST || "127.0.0.1";
const IDENTITY_ROUTE = "/__tuic_dev_root"; // keep in sync with vite.config.ts

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));

/** @returns {Promise<{ state: "free" | "ours" | "stranger", root?: string }>} */
async function probe() {
  try {
    const res = await fetch(`http://${HOST}:${PORT}${IDENTITY_ROUTE}`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return { state: "stranger" };
    const served = path.resolve((await res.text()).trim());
    return served === root ? { state: "ours", root: served } : { state: "stranger", root: served };
  } catch (err) {
    // Nobody listening — the port is ours to take. Anything else (timeout,
    // reset, a non-HTTP server) means someone is squatting on it.
    return err?.cause?.code === "ECONNREFUSED" ? { state: "free" } : { state: "stranger" };
  }
}

const found = await probe();

if (found.state === "ours") {
  console.log(`[dev] Vite already serving this checkout on ${HOST}:${PORT} — reusing it.`);
  process.exit(0);
}

if (found.state === "stranger") {
  console.error(
    `[dev] Port ${PORT} is taken by something that is not this checkout's dev server` +
      `${found.root ? ` (it serves ${found.root})` : ""}.\n` +
      `[dev] Vite cannot fall back to another port — Tauri's devUrl is pinned to ` +
      `http://${HOST}:${PORT}. Stop the other process, then retry.`,
  );
  process.exit(1);
}

// Vite 8 dropped `./bin/vite.js` from its `exports` map, so resolve the package
// root (`./package.json` is still exported) and reach the CLI from there.
const vitePkg = fileURLToPath(import.meta.resolve("vite/package.json"));
const vite = path.join(path.dirname(vitePkg), "bin", "vite.js");
const child = spawn(process.execPath, [vite, ...process.argv.slice(2)], { stdio: "inherit" });
child.on("exit", (code, signal) => process.exit(signal ? 1 : (code ?? 0)));
