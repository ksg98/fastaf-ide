import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import path from "node:path";
const root = process.cwd();
export default defineConfig({root,plugins:[{name:"isolated-mobile-question",enforce:"pre",resolveId(source,importer){if(!importer)return;const resolved=path.resolve(path.dirname(importer),source);if(["/src/transport","/src/mobile/useMobileVoice","/src/mobile/components/OutputView"].some(p=>resolved===root+p))return root+"/scripts/mobile-question-visual/stubs.tsx";}},solid()],define:{__APP_VERSION__:JSON.stringify("visual-fixture"),__BUILD_GIT_HASH__:JSON.stringify("1973")},server:{host:"127.0.0.1",port:15473,strictPort:true}});
