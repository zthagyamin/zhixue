import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';

// Execute the actual fixture composition and its ready effect, without starting a
// server, browser, IndexedDB, or the stateful product children.
const source=readFileSync(process.env.RELIABILITY_FIXTURE_SOURCE||new URL('./fixtures/reliability-browser-entry.txt',import.meta.url),'utf8');
const parsed=ts.createSourceFile('fixture.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
const app=parsed.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='App');
const flag=parsed.statements.flatMap(node=>ts.isVariableStatement(node)?[...node.declarationList.declarations]:[]).find(node=>node.name.getText(parsed)==='paperQuestionMode');
function compose(mode){
 const io={ready:false},params=new URLSearchParams();
 const paperQuestionMode=flag?new Function('mode',`return (${flag.initializer.getText(parsed)});`)(mode):undefined;
 const components={StudyLayoutRuntime:'layout-runtime',StudyLayoutControl:'layout-control',PaperFixture:'paper-question',QuizFixture:'quiz',StructuredQuiz:'structured',TutorFixture:'tutor',PaperSourcesFixture:'paper-sources',PairFixture:'pair',SourcesFixture:'sources'};
 const runtime={jsx:(type,props)=>({type,props}),jsxs:(type,props)=>({type,props}),Fragment:'fragment'};
 const compiled=ts.transpileModule(app.getText(parsed),{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS}}).outputText;
 const bindings={...components,mode,paperQuestionMode,io,params,useEffect:fn=>fn(),quiz:{}};
 const render=new Function(...Object.keys(bindings),'require','exports',compiled+'\nreturn App;')(...Object.values(bindings),()=>runtime,{});
 const view=render(),types=[];
 const walk=node=>{if(Array.isArray(node)){node.forEach(walk);return;}if(node&&typeof node==='object'&&node.props){types.push(node.type);walk(node.props.children);}};walk(view);
 return {types,ready:io.ready};
}
for(const mode of ['paper-save','paper-lost','paper-conflict'])test(`fixture ${mode} waits for the real question session`,()=>{
 const view=compose(mode);assert.ok(view.types.includes('paper-question'));assert.equal(view.ready,false);
});
test('paper-sources mounts the actual source picker and becomes ready independently of a question session',()=>{
 const view=compose('paper-sources');assert.ok(view.types.includes('paper-sources'));assert.ok(!view.types.includes('paper-question'));assert.equal(view.ready,true);
});
test('nonword mounts its own interaction and becomes ready independently',()=>{
 const view=compose('nonword');assert.ok(view.types.includes('quiz'));assert.ok(!view.types.includes('paper-question'));assert.equal(view.ready,true);
});
test('source-picker fixture loads the same component stylesheet as both real paper entrypoints',()=>{
 const imports=tree=>tree.statements.filter(ts.isImportDeclaration).map(node=>node.moduleSpecifier.text);
 const fixtureImports=imports(parsed);
 for(const [file,style] of [['../app/plugins/plugin-paper.tsx','./paper.css'],['../app/paper-workshop-launcher.tsx','./plugins/paper.css']]){
  const body=readFileSync(new URL(file,import.meta.url),'utf8');
  const tree=ts.createSourceFile(file,body,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
  assert.ok(imports(tree).includes(style),`${file} must still own the real paper stylesheet`);
 }
 assert.ok(fixtureImports.includes('@repo/app/plugins/paper.css'),'The standalone source-picker fixture must load its real component stylesheet');
});
