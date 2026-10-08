// Isolated JSX/handler regressions. Hooks and integrations are doubles; this is NOT a browser test.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {resolve,dirname} from 'node:path';
import ts from 'typescript';
import {makeWordContext,contextPrompt,contextFallback,contextPieces} from '../app/word-context-model.ts';
const app=fileURLToPath(new URL('../app/',import.meta.url));
const jsx=(type,props,key)=>({type,props:props??{},key});
function flatten(node,found=[]){if(node===null||node===undefined||typeof node==='boolean')return found;if(Array.isArray(node)){for(const child of node)flatten(child,found);return found;}if(typeof node!=='object')return found;if(typeof node.type==='function')return flatten(node.type(node.props),found);found.push(node);flatten(node.props?.children,found);return found;}
function text(node){if(node===null||node===undefined||typeof node==='boolean')return '';if(Array.isArray(node))return node.map(text).join('');if(typeof node!=='object')return String(node);if(typeof node.type==='function')return text(node.type(node.props));return text(node.props?.children);}
function compiler(file,require,window){const output={};const code=ts.transpileModule(readFileSync(file,'utf8'),{fileName:file,compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;new Function('require','exports','window',code)(require,output,window);return output;}
const jsxRuntime={jsx,jsxs:jsx,Fragment:'fragment'};
function words(stage,learned,revealed,embedded=true){
 const state={learned,revealed,clozeEnabled:false},grades=[];
 const integrations={
  'react':{useRef:value=>({current:value}),useEffect:()=>{}},'react/jsx-runtime':jsxRuntime,
  '../study-guidance':{StudyGuidance:props=>jsx('guidance',props)},
  '../use-study-shortcuts':{useStudyShortcuts:()=>{}},'../ai/use-report-study-ai-item':{useReportStudyAIItem:()=>{}},
  '../word-context-model':{makeWordContext,contextPrompt,contextFallback},
  '../word-context-view':{WordContextView:({model,concealed})=>jsx('blockquote',{children:contextPieces(model,concealed).map(piece=>piece.gap?'______':piece.text)})},
  '../word-context.css':{},'../study-plugin-options':{StudyPluginOptions:({children})=>jsx('options',{children})},'../learning-draft':{useLearningDraftState:(_draft,name,fallback)=>[state[name]??fallback,value=>{state[name]=value;}]},
  '../assistance-display':{useAssistance:()=>({}),useAssistanceDisplay:()=>{}},'./speech':{speakWord:()=>{},cancelWordSpeech:()=>{}},
 };
 const plugin=compiler(resolve(app,'plugins/plugin-three-stage.tsx'),name=>{if(!(name in integrations))throw new Error('unexpected dependency '+name);return integrations[name];}).PluginThreeStage;
 const render=()=>plugin.renderUI({data:{word:'break up with',meaning:'与某人分手',example:'Example retained.',phonetic:'',stage},context:{guidanceInOptions:embedded,guidanceScope:'owner-a'},onGrade:rating=>grades.push(rating)});
 return {state,grades,render};
}
for(const stage of [1,2,3]){
 test(`stage ${stage}: unknown-word reveal never grades until its single continuation action`,()=>{
  const f=words(stage,false,false);let nodes=flatten(f.render());const unknown=nodes.find(n=>n.type==='button'&&n.props['data-study-key']==='2');unknown.props.onClick();assert.deepEqual(f.grades,[]);assert.equal(f.state.learned,true);
  nodes=flatten(f.render());const actions=nodes.filter(n=>n.type==='button'&&n.props['data-study-key']);assert.equal(actions.length,1);assert.match(text(actions[0]),/继续练习/);assert.equal(actions[0].props['data-study-keys'],'Enter');actions[0].props.onClick();assert.deepEqual(f.grades,['again']);
 });
 test(`stage ${stage}: known-word feedback retains two genuinely different grading choices`,()=>{
  const f=words(stage,false,true);const nodes=flatten(f.render()),actions=nodes.filter(n=>n.type==='button'&&n.props['data-study-key']);assert.equal(actions.length,2);actions[0].props.onClick();actions[1].props.onClick();assert.deepEqual(f.grades,['good','again']);
 });
}
test('word content, example and audio remain, while repeated boilerplate is absent',()=>{
 const first=words(1,true,true).render(),second=words(2,false,true).render();assert.match(text(first),/break up with/);assert.match(text(first),/与某人分手/);assert.match(text(second),/Example retained/);
 assert.equal(flatten(first).filter(n=>n.props['aria-label']==='朗读单词').length,1);
 assert.doesNotMatch(text(first),/选择你对这个词|看完释义后|Space.*朗读/);
});
test('embedded stage metadata lives in the host, standalone plugin retains one compact stage',()=>{
 assert.equal(flatten(words(2,false,false).render()).filter(n=>n.props.className==='study-stage-compact').length,0);
 const standalone=flatten(words(2,false,false,false).render()).filter(n=>n.props.className==='study-stage-compact');assert.equal(standalone.length,1);assert.equal(text(standalone[0]),'语境 · 2/3');
});
function guidanceFixture(){
 const values=new Map(),events=new Map(),effects=[],subscriptions=[];const window={localStorage:{getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)},addEventListener:(k,fn)=>{const set=events.get(k)??new Set();set.add(fn);events.set(k,set);},removeEventListener:(k,fn)=>events.get(k)?.delete(fn)};
 const react={useMemo:fn=>fn(),useEffect:fn=>effects.push(fn),useSyncExternalStore:(subscribe,snapshot)=>{subscriptions.push(subscribe(()=>{}));return snapshot();}};
 const cache=new Map();function load(file){if(cache.has(file))return cache.get(file);const exports=compiler(file,name=>{if(name==='react')return react;if(name==='react/jsx-runtime')return jsxRuntime;if(name.endsWith('.css'))return {};if(name.startsWith('.'))return load(resolve(dirname(file),name+'.ts'));throw new Error(name);},window);cache.set(file,exports);return exports;}
 const components=load(resolve(app,'study-guidance.tsx'));return {values,events,effects,components,flush(){while(effects.length)effects.shift()();},close(){subscriptions.forEach(fn=>fn());}};
}
test('tip acknowledgement removes the first-use row but manual help remains retrievable',()=>{
 const f=guidanceFixture(),props={topic:'quiz',context:{guidanceScope:'owner-a',guidanceInOptions:true}};
 let tree=f.components.StudyGuidance(props);assert.match(text(tree),/先判断选项/);const dismiss=flatten(tree).find(n=>n.type==='button');dismiss.props.onClick({currentTarget:{closest:()=>null}});
 assert.equal(f.components.StudyGuidance(props),null);assert.match(text(f.components.StudyGuidanceHelp({kind:'quiz'})),/操作说明与快捷键/);assert.equal(f.values.size,1);f.close();
});
test('completing the described action acknowledges the mode without a second confirmation',()=>{
 const f=guidanceFixture(),props={topic:'calculation',context:{guidanceScope:'owner-a',guidanceInOptions:true}};
 assert.equal(f.components.StudyGuidance({...props,engaged:true}),null);f.flush();assert.equal(f.components.StudyGuidance(props),null);f.close();
});
test('returning via another subject keeps instructions quiet; another owner remains independent',()=>{
 const f=guidanceFixture();f.components.StudyGuidance({topic:'quiz',context:{guidanceScope:'owner-a'},engaged:true});f.flush();
 assert.equal(f.components.StudyGuidance({topic:'quiz',context:{guidanceScope:'owner-a',guidanceInOptions:true}}),null);
 assert.match(text(f.components.StudyGuidance({topic:'quiz',context:{guidanceScope:'owner-b',guidanceInOptions:true}})),/知道了/);f.close();
});
test('all eight plugins are connected to the shared first-use component',()=>{
 for(const name of ['plugins/plugin-three-stage.tsx','plugins/plugin-flashcard.tsx','plugins/plugin-spelling.tsx','plugins/plugin-quiz.tsx','plugins/structured-quiz.tsx','plugin-recall.tsx','plugin-calculation.tsx','plugins/plugin-code.tsx','plugins/plugin-paper.tsx'])assert.match(readFileSync(resolve(app,name),'utf8'),/<StudyGuidance\s/,name);
});
test('review explanations are inside host learning options rather than the question body',()=>{
 const source=readFileSync(resolve(app,'study-dashboard/subject-view.tsx'),'utf8');
 const start=source.indexOf('options={<>'),end=source.indexOf('<LearningDraftBoundary',start);assert.ok(start>=0);assert.match(source.slice(start,end),/<ReviewContext/);assert.doesNotMatch(source.slice(end),/<ReviewContext/);
 assert.match(source,/<StudyGuidanceHelp kind=\{actualPluginType\}/);assert.match(source,/guidanceScope:workspaceId,guidanceInOptions:true/);
});
test('save status keeps full receipt wording behind disclosure and urgent states in a visible live message',()=>{
 const source=readFileSync(resolve(app,'study-save-status.tsx'),'utf8');assert.match(source,/status.attention && <p role="status"/);assert.match(source,/<details aria-label="辅助摘要同步状态"/);assert.match(source,/auxiliaryDeliveryLabel\(state\)/);
 const calc=readFileSync(resolve(app,'plugin-calculation.tsx'),'utf8');assert.match(calc,/正在保存作答/);assert.match(calc,/重试保存/);assert.match(calc,/continueAfterFeedback/);
});
