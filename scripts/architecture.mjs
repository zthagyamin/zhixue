import ts from 'typescript';
import {readFileSync,readdirSync,existsSync,writeFileSync} from 'node:fs';
import {resolve,relative,posix} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

const normalize=text=>text.replace(/\r\n/g,'\n');
const slash=text=>text.replaceAll('\\','/');
const extensions=['.ts','.tsx','.mts','.mjs','.js'];
const sourceFile=(name,text)=>ts.createSourceFile(name,text,ts.ScriptTarget.Latest,true,name.endsWith('.tsx')?ts.ScriptKind.TSX:ts.ScriptKind.TS);
export function readDependencies(name,text){
 const source=sourceFile(name,text),edges=[];
 const add=(node,value,typeOnly=false)=>edges.push({specifier:ts.isStringLiteralLike(value)?value.text:null,typeOnly,line:source.getLineAndCharacterOfPosition(node.getStart(source)).line+1});
 function visit(node){
  if(ts.isImportDeclaration(node)){
   const clause=node.importClause,names=clause?.namedBindings;
   const only=Boolean(clause?.isTypeOnly||!clause?.name&&names&&ts.isNamedImports(names)&&names.elements.length&&names.elements.every(e=>e.isTypeOnly));
   add(node,node.moduleSpecifier,only);
  }else if(ts.isImportEqualsDeclaration(node)&&ts.isExternalModuleReference(node.moduleReference)&&node.moduleReference.expression){
   add(node,node.moduleReference.expression,Boolean(node.isTypeOnly));
  }else if(ts.isExportDeclaration(node)&&node.moduleSpecifier){
   const clause=node.exportClause,only=node.isTypeOnly||clause&&ts.isNamedExports(clause)&&clause.elements.length&&clause.elements.every(e=>e.isTypeOnly);
   add(node,node.moduleSpecifier,Boolean(only));
  }else if(ts.isImportTypeNode(node)&&ts.isLiteralTypeNode(node.argument))add(node,node.argument.literal,true);
  else if(ts.isCallExpression(node)&&(node.expression.kind===ts.SyntaxKind.ImportKeyword||ts.isIdentifier(node.expression)&&node.expression.text==='require')){
   if(node.arguments[0])add(node,node.arguments[0]);
  }
  ts.forEachChild(node,visit);
 }
 visit(source);return edges;
}
function sourceMetrics(name,text,dependencies){
 const code=normalize(text),source=sourceFile(name,code);let stateHooks=0;
 function visit(node){if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&['useState','useReducer','useRef','useEffect','useLayoutEffect'].includes(node.expression.text))stateHooks++;ts.forEachChild(node,visit);}
 visit(source);
 return {file:name,lines:code.trimEnd().split('\n').length,bytes:Buffer.byteLength(code),imports:dependencies.length,stateHooks,maxLine:Math.max(...code.split('\n').map(line=>line.length))};
}
function moduleOf(file){const match=/^src\/(domain|application|infrastructure|features)\/([^/]+)\//.exec(file);return match?{layer:match[1],id:match[1]+'/'+match[2]}:null;}
function localTarget(from,specifier,sources){
 if(!specifier||!(specifier.startsWith('.')||specifier.startsWith('@/')))return null;
 const root=specifier.startsWith('@/')?specifier.slice(2):posix.normalize(posix.join(posix.dirname(from),specifier));
 return [root,...extensions.map(ext=>root+ext),...extensions.map(ext=>root+'/index'+ext)].find(path=>Object.hasOwn(sources,path))??null;
}
function runtimeComponents(files,edges){
 const graph=new Map(files.map(file=>[file,[]]));for(const edge of edges)if(!edge.typeOnly)graph.get(edge.from).push(edge.to);
 const positions=new Map(),low=new Map(),stack=[],active=new Set(),components=[];let cursor=0;
 function visit(node){
  positions.set(node,cursor);low.set(node,cursor++);stack.push(node);active.add(node);
  for(const next of graph.get(node)){if(!positions.has(next)){visit(next);low.set(node,Math.min(low.get(node),low.get(next)));}else if(active.has(next))low.set(node,Math.min(low.get(node),positions.get(next)));}
  if(low.get(node)===positions.get(node)){const group=[];let next;do{next=stack.pop();active.delete(next);group.push(next);}while(next!==node);if(group.length>1||graph.get(node).includes(node))components.push(group.sort());}
 }
 for(const node of files)if(!positions.has(node))visit(node);return components.sort((a,b)=>a[0].localeCompare(b[0]));
}
export function auditSources(sources,policy={}){
 const files=Object.keys(sources).sort(),edges=[],metrics=[],violations=[];
 const add=(code,file,message,line)=>violations.push({code,file,...(line?{line}:{}),message});
 const allowed={domain:['domain'],application:['domain','application'],features:['domain','application','features'],infrastructure:['domain','application','infrastructure']};
 for(const file of files){
  const deps=readDependencies(file,sources[file]),metric=sourceMetrics(file,sources[file],deps),owner=moduleOf(file);metrics.push(metric);
  if(file.startsWith('src/')&&!owner)add('unowned-module',file,'Place production code in a named domain/application/features/infrastructure module.');
  if(owner&&(metric.lines>450||metric.bytes>32000))add('module-size',file,'New modules must stay within 450 lines and 32 KB; split by responsibility.');
  if(policy.legacyRootFiles&&/^app\/[^/]+\.[cm]?[jt]sx?$/.test(file)&&!['page','layout','error','global-error','not-found','loading','template','route','favicon','robots','sitemap','manifest'].includes(posix.basename(file).split('.')[0])&&!policy.legacyRootFiles.includes(file))add('new-flat-legacy-file',file,'New business modules belong under src/, not the legacy app root.');
  const budget=policy.hotspots?.[file];
  if(budget&&['lines','bytes','imports'].some(key=>metric[key]>budget[key]))add('legacy-growth',file,`Legacy ceiling exceeded: ${JSON.stringify({lines:metric.lines,bytes:metric.bytes,imports:metric.imports})}. Extract responsibility or review an explicit exception.`);
  for(const edge of deps){
   if(edge.specifier===null){if(owner)add('nonliteral-import',file,'Managed modules require statically reviewable imports.',edge.line);continue;}
   const target=localTarget(file,edge.specifier,sources),other=target&&moduleOf(target);
   if(target)edges.push({from:file,to:target,typeOnly:edge.typeOnly,line:edge.line});
   if(owner){
    if(target&&(!other||!allowed[owner.layer].includes(other.layer)))add('layer-direction',file,`${owner.id} must not depend on ${target}, including type-only imports.`,edge.line);
    if(!target&&(edge.specifier.startsWith('.')||edge.specifier.startsWith('@/')))add('unresolved-import',file,edge.specifier,edge.line);
    if(owner.layer==='domain'&&!target)add('domain-external',file,`Domain rules may not depend on packages, platform modules or unresolved code: ${edge.specifier}`,edge.line);
    if(owner.layer==='application'&&!target&&!edge.specifier.startsWith('.')&&!edge.specifier.startsWith('@/'))add('application-external',file,`Application use cases depend on domain rules and injected ports, not packages: ${edge.specifier}`,edge.line);
    if(owner.layer==='features'&&!target&&/^(?:node:|drizzle-orm|@cloudflare\/|wrangler)/.test(edge.specifier))add('feature-infrastructure',file,'Views must use application ports instead of platform/database modules.',edge.line);
    if(other&&owner.id!==other.id&&!/\/index\.[cm]?[jt]sx?$/.test(target))add('private-module-import',file,`Use the public index of ${other.id}.`,edge.line);
   }
  }
  if(owner?.layer==='domain'){
   const source=sourceFile(file,sources[file]),effects=new Set(['window','document','navigator','localStorage','sessionStorage','indexedDB','process','fetch','XMLHttpRequest','WebSocket','Worker','eval','Function','setTimeout','setInterval','crypto','performance']);
   function check(node){
    // Existing content IDs use a deterministic digest, not random identities or I/O.
    const parent=node.parent,deterministicDigest=ts.isIdentifier(node)&&node.text==='crypto'&&ts.isPropertyAccessExpression(parent)&&parent.expression===node&&parent.name.text==='subtle'&&ts.isPropertyAccessExpression(parent.parent)&&parent.parent.expression===parent&&parent.parent.name.text==='digest';
    if(ts.isIdentifier(node)&&effects.has(node.text)&&!deterministicDigest&&!(ts.isPropertySignature(node.parent)&&node.parent.name===node))add('domain-effect',file,`Inject I/O at the application boundary: ${node.text}`,source.getLineAndCharacterOfPosition(node.getStart(source)).line+1);
    if(ts.isCallExpression(node)&&['Math.random','Date.now'].includes(node.expression.getText(source)))add('domain-effect',file,'Time and randomness must be explicit inputs.');
    if(ts.isNewExpression(node)&&node.expression.getText(source)==='Date'&&!node.arguments?.length)add('domain-effect',file,'Current time must be an explicit input.');
    ts.forEachChild(node,check);
   }
   check(source);
  }
 }
 const cycles=runtimeComponents(files,edges),cycleEdges=edges.filter(edge=>!edge.typeOnly&&cycles.some(group=>group.includes(edge.from)&&group.includes(edge.to))).map(edge=>`${edge.from} -> ${edge.to}`).sort();
 for(const edge of cycleEdges)if(!policy.allowedCycleEdges?.includes(edge))add('new-runtime-cycle',edge.split(' -> ')[0],edge);
 return {summary:{files:files.length,edges:edges.length,runtimeCycles:cycles.length},metrics,cycles,cycleEdges,violations};
}
export function readProjectSources(root){
 const sources={};
 const walk=directory=>{if(!existsSync(directory))return;for(const entry of readdirSync(directory,{withFileTypes:true})){const path=resolve(directory,entry.name);if(entry.isDirectory()){if(!['node_modules','dist','.next','__pycache__'].includes(entry.name))walk(path);}else if(extensions.some(ext=>entry.name.endsWith(ext))&&!entry.name.endsWith('.d.ts'))sources[slash(relative(root,path))]=readFileSync(path,'utf8');}};
 for(const name of ['app','src','db','worker'])walk(resolve(root,name));
 if(existsSync(resolve(root,'middleware.ts')))sources['middleware.ts']=readFileSync(resolve(root,'middleware.ts'),'utf8');
 return sources;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const root=resolve('.'),sources=readProjectSources(root),config=resolve(root,'architecture.config.json');
 const policy=existsSync(config)?JSON.parse(readFileSync(config,'utf8')):{};
 const report=auditSources(sources,policy),reportIndex=process.argv.indexOf('--report');
 const python=spawnSync(process.env.PYTHON||'python',['-X','utf8',resolve(root,'scripts/companion-architecture.py'),root],{encoding:'utf8',windowsHide:true});
 if(python.error||python.status!==0){report.violations.push({code:'python-check-unavailable',file:'companion',message:python.error?.message||python.stderr||'Python boundary check failed.'});}
 else{
  const companion=JSON.parse(python.stdout);report.summary.companion=companion.summary;
  report.metrics.push(...companion.metrics);report.violations.push(...companion.violations);
 }
 for(const [file,budget] of Object.entries(policy.pythonHotspots??{})){
  const code=normalize(readFileSync(resolve(root,file),'utf8'));
  const metric={file,lines:code.trimEnd().split('\n').length,bytes:Buffer.byteLength(code)};
  report.metrics.push(metric);
  if(metric.lines>budget.lines||metric.bytes>budget.bytes)report.violations.push({code:'legacy-growth',file,message:'Python composition root grew; extract its responsibility or review an explicit exception.'});
 }
 if(reportIndex>=0)writeFileSync(resolve(process.argv[reportIndex+1]),JSON.stringify(report,null,2)+'\n');
 console.log(JSON.stringify({summary:report.summary,violations:report.violations},null,2));
 if(!process.argv.includes('--audit-only')&&report.violations.length)process.exitCode=1;
}
