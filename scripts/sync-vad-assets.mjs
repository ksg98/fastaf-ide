// Copy Silero VAD + onnxruntime-web runtime assets into public/vad/ so vite
// serves them with correct MIME types in dev and bundles them into dist/vad/
// at build. Runs via the predev/prebuild hooks; public/vad/ is gitignored.
//
// createRequire resolution handles pnpm's symlinked node_modules layout —
// plain path globs miss it (which is why vite-plugin-static-copy served 404s).

import { copyFileSync, mkdirSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = dirname(fileURLToPath(import.meta.url));
const dest = join(root, "..", "public", "vad");
mkdirSync(dest, { recursive: true });

const vadDist = join(dirname(require.resolve("@ricky0123/vad-web/package.json")), "dist");
// onnxruntime-web's exports map hides package.json — resolve the entry point
// (somewhere under dist/) and walk back to the dist directory.
const ortEntry = require.resolve("onnxruntime-web");
const ortDist = join(ortEntry.slice(0, ortEntry.lastIndexOf("/dist/")), "dist");

// Only the CPU-wasm runtime the VAD actually fetches — the jsep/asyncify/jspi
// variants and ort.* bundles are tens of MB and never requested.
const files = [
	join(vadDist, "vad.worklet.bundle.min.js"),
	join(vadDist, "silero_vad_v5.onnx"),
	join(vadDist, "silero_vad_legacy.onnx"),
	...readdirSync(ortDist)
		.filter((f) => f === "ort-wasm-simd-threaded.wasm" || f === "ort-wasm-simd-threaded.mjs")
		.map((f) => join(ortDist, f)),
];

for (const src of files) {
	copyFileSync(src, join(dest, src.split("/").pop()));
}
console.log(`[sync-vad-assets] ${files.length} files → public/vad/`);
