import {readFileSync,existsSync,statSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,resolve,extname} from 'node:path';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
const require=createRequire(import.meta.url);
const cache=new Map();
export function loadTsx(relative){
  const file=relative instanceof URL?fileURLToPath(relative):relative;
  if(cache.has(file))return cache.get(file);
  const source=readFileSync(file,'utf8'),exports={};cache.set(file,exports);
  const compiled=ts.transpileModule(source,{fileName:file,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
  const localRequire=specifier=>{
    // CSS has no server-rendered markup; layout is checked in the real browser.
    if(specifier.endsWith('.css'))return {};
    if(!specifier.startsWith('.'))return require(specifier);
    const stem=resolve(dirname(file),specifier),found=[stem,stem+'.tsx',stem+'.ts',stem+'/index.tsx',stem+'/index.ts'].find(candidate=>existsSync(candidate)&&statSync(candidate).isFile());
    if(!found)throw new Error(`Component dependency missing: ${specifier}`);
    return ['.ts','.tsx'].includes(extname(found))?loadTsx(found):require(found);
  };
  try{new Function('require','exports',compiled)(localRequire,exports);}catch(error){cache.delete(file);throw error;}
  return exports;
}
