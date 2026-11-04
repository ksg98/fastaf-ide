#!/usr/bin/env node
// Keep test selection explicit when Stryker runs Vitest once per mutant.
// Stryker's Vitest runner reports false survivors with this repo's Vitest 5.

import { spawnSync } from "node:child_process";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function run(args, env = process.env) {
  const result = spawnSync(pnpm, args, { stdio: "inherit", env, shell: process.platform === "win32" });
  if (result.error) {
    process.stderr.write(`${result.error.message}\n`);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
}

if (process.argv[2] === "--runner") {
  const files = JSON.parse(process.env.TUIC_MUTATION_TEST_FILES ?? "[]");
  if (!Array.isArray(files) || files.length === 0 || files.some((file) => typeof file !== "string")) {
    process.stderr.write("Mutation runner requires TUIC_MUTATION_TEST_FILES.\n");
    process.exit(2);
  }
  run(["exec", "vitest", "run", ...files]);
}

const separator = process.argv.indexOf("--", 2);
const sources = process.argv.slice(2, separator);
const tests = separator < 0 ? [] : process.argv.slice(separator + 1);
if (sources.length === 0 || tests.length === 0 || sources.some((file) => file.startsWith("--"))) {
  process.stderr.write("Usage: node scripts/ts-mutants.mjs <source.ts[:range]>... -- <test.ts>...\n");
  process.exit(2);
}

run(["exec", "stryker", "run", "--mutate", sources.join(",")], {
  ...process.env,
  TUIC_MUTATION_TEST_FILES: JSON.stringify(tests),
});
