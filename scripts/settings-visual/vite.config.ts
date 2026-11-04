import {defineConfig} from 'vite';
import solid from 'vite-plugin-solid';
import path from 'node:path';
const root=process.cwd();
export default defineConfig({root,plugins:[{name:'isolated-settings-rpc',enforce:'pre',resolveId(source,importer){if(!importer)return; const resolved=path.resolve(path.dirname(importer),source);if(['/src/invoke','/src/transport','/src/stores/appLogger'].some(p=>resolved===root+p))return root+'/scripts/settings-visual/rpc.ts';}},solid()],define:{__APP_VERSION__:JSON.stringify('visual-audit'),__BUILD_GIT_HASH__:JSON.stringify('dbe0a3a9')},server:{host:'127.0.0.1',port:15391,strictPort:true}});
