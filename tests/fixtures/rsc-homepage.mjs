import assert from 'node:assert/strict';
import {readFileSync,existsSync,statSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,resolve,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {createClientModuleProxy} from 'react-server-dom-webpack/server.node';

// Execute the real server page with React's client references at each RSC boundary.
// Only authentication is replaced: this check must not need a personal session.
const require=createRequire(import.meta.url),cache=new Map();
const root=fileURLToPath(new URL('../../app/',import.meta.url));
function loadServerModule(file){
  if(cache.has(file))return cache.get(file);
  const source=readFileSync(file,'utf8');
  if(/^\s*["']use client["'];/.test(source)){
    const reference=createClientModuleProxy(file);cache.set(file,reference);return reference;
  }
  const exports={};cache.set(file,exports);
  const localRequire=specifier=>{
    if(specifier.endsWith('.css'))return {};
    if(!specifier.startsWith('.'))return require(specifier);
    const stem=resolve(dirname(file),specifier);
    const target=[stem,stem+'.tsx',stem+'.ts',stem+'/index.tsx',stem+'/index.ts'].find(path=>existsSync(path)&&statSync(path).isFile());
    if(!target)throw new Error(`Missing server dependency: ${specifier}`);
    if(target===resolve(root,'chatgpt-auth.ts'))return {getChatGPTUser:async()=>null};
    return ['.ts','.tsx'].includes(extname(target))?loadServerModule(target):require(target);
  };
  const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
  new Function('require','exports',compiled)(localRequire,exports);
  return exports;
}
const page=loadServerModule(resolve(root,'page.tsx'));
const result=await page.default();
assert.ok(result?.type,'The homepage must return a renderable element.');
assert.equal(result.props.signedIn,false,'A signed-out request must retain guest navigation.');
