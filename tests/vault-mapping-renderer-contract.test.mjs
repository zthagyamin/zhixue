import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {recallReference} from '../app/recall-flow-model.ts';
import ts from 'typescript';
import {adaptStudyItemForPlugin} from '../app/plugin-routing.ts';
import {readDashboardSourceSync} from './helpers/dashboard-source.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
function parsedFile(relative){const text=relative==='app/study-dashboard.tsx'?readDashboardSourceSync():readFileSync(new URL('../'+relative,import.meta.url),'utf8');return ts.createSourceFile(relative,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);}
function declaration(source,name,kind){let found;function visit(node){if(kind(node)&&node.name?.getText(source)===name)found=node;ts.forEachChild(node,visit);}visit(source);assert.ok(found,`production declaration ${name}`);return found.getText(source);}
function evaluate(source){return vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{exports:{},module:{exports:{}},recallReference});}
function catalog(){
  const python=process.env.PYTHON||process.env.GATEWAY_TEST_PYTHON||(process.platform==='win32'&&spawnSync('where.exe',['py.exe']).status===0?'py':'python');
  const script=`import sys,json,tempfile\nfrom pathlib import Path\nsys.path.insert(0,str(Path('companion').resolve()))\nimport vault_topology as vt\nwith tempfile.TemporaryDirectory() as directory:\n root=Path(directory)/'vault';root.mkdir();db=Path(directory)/'metadata.db';rules=[]\n for name,mode,body in [('heading','heading','## Question\\nGrounded answer'),('callout','callout','> [!question] Question\\n> Grounded answer'),('table','table','| prompt | answer |\\n|---|---|\\n| Question | Grounded answer |')]:\n  (root/(name+'.md')).write_text(body,encoding='utf-8');rules.append(dict(pathGlob=name+'.md',subjectId='mapped:'+name,subjectLabel='Concepts',contentKind='quiz',splitMode=mode,headingLevel=2))\n for name,kind in [('vocabulary','vocabulary'),('python','code')]:\n  (root/(name+'.md')).write_bytes(Path('public/knowledge-starter-kit/'+name+'.md').read_bytes());rules.append(dict(pathGlob=name+'.md',subjectId='mapped:'+name,subjectLabel=name,contentKind=kind,splitMode='table',headingLevel=2))\n vt.save(db,root,'owner',rules,0)\n print(json.dumps(vt.merge({'subjects':[]},root,db,'owner')))\n`;
  const result=spawnSync(python,['-c',script],{cwd:root,encoding:'utf8',env:{...process.env,PYTHONUTF8:'1'}});assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
}
const fixture=catalog();
// Evaluate the actual private UI declarations rather than duplicate their routing/fallback logic.
// This keeps the bounded parser fix independent of root-owned dashboard and recall component exports.
test('mapped heading, callout and table answers survive actual adapter and offline fallback',()=>{
  const source=parsedFile('app/plugin-recall.tsx');
  const reference=declaration(source,'reference',ts.isVariableDeclaration),fallback=declaration(source,'fallback',ts.isVariableDeclaration);
  const offline=evaluate(`(function(data){const context=undefined,assistance=undefined,criteria=[],support=undefined,focusFeedback={current:false};let result;const setResult=value=>{result=value},setFallbackNotice=()=>{},setRevealed=()=>{},setSelectedRating=()=>{};const ${reference};const ${fallback};fallback('offline');return {result,reference};})`);
  for(const subject of fixture.subjects.filter(row=>row.pluginType==='recall')){
    const adapted=adaptStudyItemForPlugin(subject.pluginType,subject.items[0]);assert.ok(adapted);
    const output=offline(adapted);assert.equal(output.result.source,'self-assess');assert.equal(output.reference,'Grounded answer');
  }
});
test('mapped concepts, vocabulary and code use actual dashboard event classification',()=>{
  const source=parsedFile('app/study-dashboard.tsx');
  const classify=evaluate(`${declaration(source,'domainForSubject',ts.isFunctionDeclaration)}\n${declaration(source,'itemKindForDomain',ts.isFunctionDeclaration)}\n(subject=>({domain:domainForSubject(subject),kind:itemKindForDomain(domainForSubject(subject))}))`);
  for(const subject of fixture.subjects){
    const result=classify(subject);
    const expected=subject.pluginType==='recall'?['differential-review','due']:subject.pluginType==='code'?['python','python']:['ielts','word'];
    assert.deepEqual([result.domain,result.kind],expected,subject.id);
  }
});
