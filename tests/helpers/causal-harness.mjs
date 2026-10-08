// Deterministic hooks and service doubles, executing the current source bytes.
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';
import {createRequire} from 'node:module';
import {createSourceCompiler} from './source-compiler.mjs';
const typescript=await import(process.env.TYPESCRIPT_MODULE?pathToFileURL(path.resolve(process.env.TYPESCRIPT_MODULE,'lib/typescript.js')).href:'typescript');
const ts=typescript.default??typescript,ROOT=fileURLToPath(new URL('../../',import.meta.url));
const requirePackage=createRequire(import.meta.url);
// This worker may reuse compilation, but each loader executes its own modules
// with its own React hooks, service doubles and module state.
const compileSource=createSourceCompiler((source,file)=>ts.transpileModule(source,{fileName:file,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText);
function createHooks(){
 const slots=[];let cursor=0,effects=[],component,props,view;const same=(a,b)=>a&&b&&a.length===b.length&&a.every((x,i)=>Object.is(x,b[i]));
 const api={
  createElement(type,props,...children){return {type,props:{...props,children:children.length===1?children[0]:children}};},Fragment:'Fragment',
  createContext(v){return {Provider:()=>null,_value:v};},useContext(c){return c._value;},
  useState(init){const i=cursor++;if(!slots[i])slots[i]={value:typeof init==='function'?init():init};return [slots[i].value,value=>{slots[i].value=typeof value==='function'?value(slots[i].value):value;}];},
  useRef(init){const i=cursor++;return(slots[i]??={current:init});},
  useMemo(fn,deps){const i=cursor++;if(!slots[i]||!same(slots[i].deps,deps))slots[i]={deps,value:fn()};return slots[i].value;},
  useCallback(fn,deps){return api.useMemo(()=>fn,deps);},
  useEffect(fn,deps){const i=cursor++;if(!slots[i]||!same(slots[i].deps,deps)){const old=slots[i];slots[i]={deps,cleanup:old?.cleanup};effects.push(()=>{old?.cleanup?.();slots[i].cleanup=fn();});}},
  useLayoutEffect(fn,deps){api.useEffect(fn,deps);},useSyncExternalStore(sub,get){cursor++;return get();},useId(){return api.useRef('synthetic-'+cursor).current;}
 };
 return{api,mount(c,p){component=c;props=p;return this.render();},render(p=props){props=p;cursor=0;return(view=component(props));},flush(){const batch=effects;effects=[];batch.forEach(fn=>fn());},view:()=>view,unmount(){slots.forEach(x=>x?.cleanup?.());}};
}
function resolve(source,from,overrides={}){if(!source.startsWith('.'))return source;const base=path.resolve(path.dirname(from),source);for(const file of [base,base+'.ts',base+'.tsx',base+'.mjs',path.join(base,'index.ts')])if(Object.hasOwn(overrides,path.relative(ROOT,file).replaceAll('\\','/'))||fs.existsSync(file)&&fs.statSync(file).isFile())return path.relative(ROOT,file).replaceAll('\\','/');throw Error('Unresolved source '+source+' from '+from);}
function loader(react,overrides={},window={}){
 // These production functions have no hooks. Resolve the real presentation and
 // composition seam while keeping stateful children in their own fixture scope.
 const pureComponents=new Set();
 const cache=new Map(),jsx=(type,props,key)=>pureComponents.has(type)?type(props??{}):({type,props:props??{},key}),runtime={jsx,jsxs:jsx,Fragment:'Fragment'};
 function load(id){
  if(id==='react')return react;if(id==='react/jsx-runtime')return runtime;if(id==='react-dom')return {createPortal:x=>x};if(id.endsWith('.css'))return{};
  if(Object.hasOwn(overrides,id))return overrides[id];if(cache.has(id))return cache.get(id).exports;
  const file=path.join(ROOT,id);
  if(!fs.existsSync(file)&&!id.startsWith('.')&&!path.isAbsolute(id))return requirePackage(id);
  const m={exports:{}};cache.set(id,m);
  const code=compileSource(file);
  new Function('require','module','exports','window','document',code)(name=>load(resolve(name,file,overrides)),m,m.exports,window,{visibilityState:'visible',addEventListener(){},removeEventListener(){}});
  if(id==='app/math-text.tsx')pureComponents.add(m.exports.MathText);
  if(id==='src/features/nonword-study/text.tsx'){pureComponents.add(m.exports.LearningText);pureComponents.add(m.exports.LearningFeedback);}
  if(id==='src/features/nonword-study/host-view.tsx')pureComponents.add(m.exports.HostView);
  if(id==='app/study-dashboard/nonword-plugin-host.tsx')pureComponents.add(m.exports.NonWordPluginHost);
  return m.exports;
 }
 return load;
}
function extract(file,name){
 const source=fs.readFileSync(path.join(ROOT,file),'utf8'),sf=ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let found;
 function visit(node){if((ts.isFunctionDeclaration(node)||ts.isVariableDeclaration(node))&&node.name?.getText(sf)===name)found=node;if(!found)ts.forEachChild(node,visit);}visit(sf);if(!found)throw Error(name+' missing');
 const raw=ts.isVariableDeclaration(found)?`const ${found.getText(sf)};`:found.getText(sf).replace(/^export\s+/,'');
 const code=ts.transpileModule(raw,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 return deps=>new Function(...Object.keys(deps),code+'\nreturn '+name+';')(...Object.values(deps));
}
function* nodes(x){if(Array.isArray(x)){for(const n of x)yield* nodes(n);}else if(x&&typeof x==='object'&&x.props){yield x;yield* nodes(x.props.children);}}
function text(x){if(Array.isArray(x))return x.map(text).join('');if(x?.props)return text(x.props.children);return x===null||x===undefined||typeof x==='boolean'?'':String(x);}
const button=(root,label)=>[...nodes(root)].find(n=>n.type==='button'&&text(n)===label);
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));
/** Pump the real async seam until observed completion; virtual lesson clocks cannot disable the deadline. */
async function waitForObservation(pump,observed,{timeoutMs=10000,label='expected async observation'}={}){
 const deadline=performance.now()+timeoutMs;
 do {await pump();if(observed())return;} while(performance.now()<deadline);
 throw Error(label+' did not arrive before the observation deadline');
}
export {createHooks,loader,extract,nodes,text,button,deferred,tick,waitForObservation};
