import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// Isolated component harness: no app-wide checker or desktop/backend process.
export default defineConfig({
	plugins: [solid()],
	optimizeDeps: { entries: ["src/components/Tasks/roadmap/harness.html"] },
});
