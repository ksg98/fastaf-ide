import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// Isolated visual fixture: real session menu, no desktop or live backend access.
export default defineConfig({
	plugins: [
		{
			name: "markdown-fixture",
			enforce: "pre",
			resolveId(id) {
				if (/(^|\/)transport$/.test(id)) return "\0markdown-transport";
			},
			load(id) {
				if (id === "\0markdown-transport")
					return `
export * from "/src/transport.ts";
export const isTauri = () => false;
export async function rpc(command) {
 if (command === 'list_open_markdown_tabs') return [
  {id:'1',title:'README.md',relative_path:'README.md',absolute_path:'/repo/README.md',fs_root:'/repo'},
  {id:'2',title:'mobile-session-navigation-and-markdown-viewer.md',relative_path:'docs/frontend/mobile-session-navigation-and-markdown-viewer.md',absolute_path:'/repo/docs/frontend/mobile-session-navigation-and-markdown-viewer.md',fs_root:'/repo'},
  {id:'3',title:'architecture.md',relative_path:'docs/architecture.md',absolute_path:'/repo/docs/architecture.md',fs_root:'/repo'}
 ];
 return [];
}
export async function subscribeEvents() { return () => {}; }
export async function subscribePty() { return Object.assign(() => {}, {pause(){},resume(){}}); }
`;
			},
		},
		solid(),
	],
	server: { host: "127.0.0.1", port: 14357, strictPort: true },
});
