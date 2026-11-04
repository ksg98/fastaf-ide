import { defineConfig } from "vite";
import solid from "vite-plugin-solid";

// Isolated visual fixture: real session menu, no desktop or live backend access.
export default defineConfig({
	plugins: [
		{
			name: "session-usage-fixture",
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
 if (command === 'list_open_markdown_tabs') return Array.from({length:14}, (_,i) => ({id:'md-'+i,title:'document-'+i+'.md',relative_path:'docs/document-'+i+'.md',absolute_path:'/repo/docs/document-'+i+'.md',fs_root:'/repo'}));
 if (command === 'get_session_usage') {
  const mode = new URLSearchParams(location.search).get('state');
  if (mode === 'loading') return new Promise(() => {});
  if (mode === 'unavailable') return {availability:'unavailable',model:null,reason:'remote session',stale:false,lines:[]};
  if (mode === 'quota') return {availability:'available',model:null,lines:[],quota_windows:[{provider:'Claude',plan:'Max',window_seconds:18000,window_name:'primary',used_percent:2,resets_at:'2026-10-26T11:20:00.093350+00:00'},{provider:'Claude',plan:'Max',window_seconds:604800,window_name:'secondary',used_percent:46,resets_at:null}]};
  return {availability:'available',model:'openai-codex/gpt-6.1-sol',reason:null,stale:mode==='stale',lines:[
   {label:'Session usage',value:'2400 input · 800 output · 200 reasoning (included in output)'},
   {label:'API-equivalent estimate',value:'≈0.0123 USD'},
   {label:'Cost unknown',value:'subscription usage is not billed API spend'}
  ]};
 }
 return [];
}
export async function subscribeEvents() { return () => {}; }
export async function subscribePty() { return Object.assign(() => {}, {pause(){},resume(){}}); }
`;
			},
		},
		solid(),
	],
	server: { host: "127.0.0.1", port: 14358, strictPort: true },
});
