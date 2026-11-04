// Dev server for the iPad scroll repro: the real app config plus a proxy that sends API
// calls to a fake backend on :$MOCK_PORT (default 9891). Run from the repo root:
//   pnpm exec vite --config tools/ipad-repro/vite.config.ts
import base from "../../vite.config";

export default async (env: { command: "serve" | "build"; mode: string }) => {
  const cfg = await (base as unknown as (e: typeof env) => Promise<Record<string, any>>)(env);
  return {
    ...cfg,
    // The type checker overlay would cover the UI under test.
    plugins: (cfg.plugins ?? []).flat(Infinity).filter((p: { name?: string } | false) => p && !p.name?.includes("checker")),
    cacheDir: process.env.TMPDIR ? `${process.env.TMPDIR}/vite-cache` : cfg.cacheDir,
    server: {
      ...cfg.server,
      port: 5188,
      host: "127.0.0.1",
      hmr: undefined,
      proxy: { "^/(?!src/|node_modules/|@|index\\.html|mobile\\.html|tools/|public/|assets/|plugins/|$)": `http://127.0.0.1:${process.env.MOCK_PORT ?? 9891}` },
    },
  };
};
