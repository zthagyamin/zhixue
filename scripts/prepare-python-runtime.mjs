import {readFile,copyFile,mkdir,writeFile} from 'node:fs/promises';
const root=new URL('../',import.meta.url),source=new URL('node_modules/pyodide/',root);
const {version,license}=JSON.parse(await readFile(new URL('package.json',source),'utf8'));
if(version!=='314.0.5')throw new Error('Review Python runtime compatibility before updating the pinned worker version.');
const target=new URL(`public/vendor/pyodide-${version}/`,root);
await mkdir(target,{recursive:true});
for(const name of ['pyodide.mjs','pyodide.asm.mjs','pyodide.asm.wasm','python_stdlib.zip','pyodide-lock.json'])await copyFile(new URL(name,source),new URL(name,target));
await writeFile(new URL('NOTICE.txt',target),`Pyodide ${version}\nLicense: ${license}\nSource and license: https://github.com/pyodide/pyodide\nPython and included libraries retain their upstream licenses.\n`);
