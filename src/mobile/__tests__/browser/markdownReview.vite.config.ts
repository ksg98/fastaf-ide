import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// Isolated visual fixture. Records the real component's request without contacting a live agent.
export default defineConfig({
	plugins: [
		{
			name: "markdown-review-fixture",
			enforce: "pre",
			resolveId(id) {
				if (/(^|\/)transport$/.test(id)) return "\0markdown-review-transport";
			},
			load(id) {
				if (id === "\0markdown-review-transport")
					return `
export * from "/src/transport.ts";
export const isTauri = () => false;
let content = "# Mobile review\\n\\n- [ ] Confirm the release notes\\n\\nShip the release on Friday.\\n";
window.__markdownReviewRequests = [];
export async function rpc(command, args) {
 if (command === "load_repositories") return {repos:{"/repo":{}}};
 if (command === "resolve_terminal_path") return {absolute_path:"/repo/review.md",is_directory:false};
 if (command === "stat_path") return {exists:true,is_dir:false,size:100};
 if (command === "fs_read_file") return content;
 if (command === "write_file_if_unchanged") {
  if (args.expected !== content) return false;
  content = args.content;
  window.__markdownReviewContent = content;
  return true;
 }
 if (command === "enqueue_agent_command") {
  window.__markdownReviewRequests.push(args);
  return {typed:false,queued:1};
 }
 return [];
}
export async function subscribeEvents() { return () => {}; }
`;
			},
		},
		solid(),
	],
	server: { host: "127.0.0.1", port: 15442, strictPort: true },
});
