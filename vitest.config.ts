import { defineConfig } from "vitest/config";
import solid from "vite-plugin-solid";
import path from "node:path";
import { mkdirSync } from "node:fs";

// Vitest workers and their dependencies inherit this path. Vite's dev/build
// configuration is separate, so normal app processes retain the OS temp dir.
const repoTmp = path.resolve(import.meta.dirname, ".tmp/tuic-tests");
const requestedTmp = process.env.TMPDIR;
const gitsRoot = process.env.HOME && path.join(process.env.HOME, "Gits");
const testTmp = requestedTmp && (
  requestedTmp.startsWith(`${import.meta.dirname}${path.sep}`)
  || (gitsRoot && requestedTmp.startsWith(`${gitsRoot}${path.sep}`))
)
  ? requestedTmp
  : repoTmp;
mkdirSync(testTmp, { recursive: true });
process.env.TMPDIR = testTmp;
process.env.TMP = testTmp;
process.env.TEMP = testTmp;

export default defineConfig({
  plugins: [solid()],
  define: {
    __APP_VERSION__: JSON.stringify("0.3.0"),
  },
  resolve: {
    conditions: ["development", "browser"],
    alias: {
      // Mock SVG imports in tests
      "^.+\\.svg$": path.resolve(import.meta.dirname, "src/__tests__/mocks/svg.ts"),
    },
  },
  test: {
    // App tests only. scripts/ holds `node:test` suites (*.test.mjs), which
    // vitest collects by default and then reports as "no test suite found".
    include: ["src/**/*.{test,spec}.{ts,tsx}"],
    css: {
      modules: {
        classNameStrategy: "non-scoped",
      },
    },
    server: {
      deps: {
        inline: ["@git-diff-view/solid", "solid-codemirror"],
      },
    },
    environment: "happy-dom",
    globals: true,
    detectAsyncLeaks: true,
    // Vitest 4 can otherwise saturate the host while initializing this large suite,
    // causing tests or even new worker processes to time out under scheduler pressure.
    maxWorkers: 4,
    setupFiles: ["src/__tests__/setup.ts", "src/__tests__/mocks/tauri.ts"],
    alias: {
      "\\.svg$": path.resolve(import.meta.dirname, "src/__tests__/mocks/svg.ts"),
    },
    coverage: {
      provider: "v8",
      include: ["src/**/*.{ts,tsx}"],
      exclude: [
        "src/__tests__/**",
        "src/index.tsx",
        "src/types/**",
        "src/**/index.ts",
        // Untestable without runtime: Tauri APIs, xterm.js, complex Tauri IPC
        "src/App.tsx",
        "src/components/Terminal/Terminal.tsx",
        "src/components/IdeLauncher/IdeLauncher.tsx",
        "src/components/PromptDrawer/PromptDrawer.tsx",
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
