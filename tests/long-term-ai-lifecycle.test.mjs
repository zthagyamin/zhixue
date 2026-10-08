import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import ts from 'typescript';
import * as advice from '../app/long-term-ai-advice.ts';
const require=createRequire(import.meta.url);
const answer=JSON.stringify({days:30,dailyMinutes:40,weekendMinutes:60,dailyReviewTarget:15,subjects:[{subjectId:'s',dailyNewTarget:10,priority:4,retention:90}]});
const spec={planId:'p',startDate:'2026-09-09',targetDeadline:'2026-11-07',dailyMinutesBudget:{workdayMin:0,workdayMax:60,weekendMax:90,minReviewRatio:.3},subjectsConfig:[{subjectId:'s',priority:3,completionCriteria:'fixed-rounds'}],bufferRatio:0};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function deferred(){let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};}
function mount(workspace,props){
 let cursor=0,tree;const slots=[],pending=[];
 const react={useCallback(fn,deps){const i=cursor++,old=slots[i];if(!old||deps.some((v,n)=>!Object.is(v,old.deps[n])))slots[i]={deps,fn};return slots[i].fn;},useState(initial){const i=cursor++;if(!(i in slots))slots[i]=typeof initial==='function'?initial():initial;return[slots[i],value=>slots[i]=typeof value==='function'?value(slots[i]):value];},useRef(initial){const i=cursor++;return slots[i]??(slots[i]={current:initial});},useLayoutEffect(effect,deps){const i=cursor++,old=slots[i];if(!old||deps.some((v,n)=>!Object.is(v,old.deps[n])))pending.push(()=>{old?.cleanup?.();slots[i]={deps,cleanup:effect()};});}};
 const source=readFileSync(new URL('../app/long-term-ai-planner.tsx',import.meta.url),'utf8');
 const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX}}).outputText;
 const exports={};new Function('require','exports',compiled)(name=>name==='react'?react:name==='./long-term-ai-advice'?advice:name.includes('study-ai-workspace')?{useOptionalStudyAIWorkspace:()=>workspace}:name.includes('study-ai-errors')?{studyAIErrorMessage:error=>error.message}:require(name),exports);
 const render=()=>{cursor=0;tree=exports.LongTermAIPlanner(props);while(pending.length)pending.shift()();return tree;};
 function nodes(node){if(!node||typeof node!=='object')return[];return[node,...[node.props?.children].flat(Infinity).flatMap(nodes)];}
 render();return{render,props,canGenerate(){return nodes(tree).some(n=>n.type==='button'&&n.props.children==='生成 AI 计划建议'&&!n.props.disabled);},unmount(){for(const slot of slots)slot?.cleanup?.();},start(){nodes(tree).find(n=>n.type==='textarea').props.onChange({target:{value:'未来30天'}});render();nodes(tree).find(n=>n.type==='button'&&n.props.children==='生成 AI 计划建议').props.onClick();render();}};
}
test('a delayed aborted request cannot release a reopened planner busy lock',async()=>{
 const first=deferred(),second=deferred();let calls=0,parentBusy=false,applied=0;
 const workspace={scope:{ownerId:'o',libraryId:'l',mode:'local'},settings:{enabled:true,configured:true,model:'mock',provider:'deepseek',revision:1},service:{async *chat(){const job=++calls===1?first:second;await job.promise;yield{type:'delta',text:answer};}}};
 const props={spec,subjects:[{subjectId:'s',name:'词汇',itemCount:100,vocabularyCount:100}],planningStart:'2026-09-09',active:true,disabled:false,onApply(){applied++;},currentSourceStamp:()=> 'fixed',onBusyChange:value=>parentBusy=value};
 const old=mount(workspace,props);old.start();assert.equal(parentBusy,true);old.unmount();assert.equal(parentBusy,false);
 const next=mount(workspace,props);next.start();assert.equal(parentBusy,true);
 first.resolve();await tick();assert.equal(parentBusy,true);assert.equal(applied,0);
 second.resolve();await tick();assert.equal(parentBusy,false);assert.equal(applied,1);next.unmount();
});
test('editing the spec invalidates pending AI advice and keeps manual changes',async()=>{
 const pending=deferred();let applied=0,busy=false;
 const workspace={scope:{ownerId:'o',libraryId:'l',mode:'local'},settings:{enabled:true,configured:true,model:'mock',provider:'deepseek',revision:1},service:{async *chat(){await pending.promise;yield{type:'delta',text:answer};}}};
 const props={spec,subjects:[],planningStart:'2026-09-09',active:true,disabled:false,onApply(){applied++;},currentSourceStamp:()=> 'fixed',onBusyChange:value=>busy=value};
 const mounted=mount(workspace,props);mounted.start();props.spec={...spec,dailyReviewTarget:2};mounted.render();assert.equal(busy,false);pending.resolve();await tick();assert.equal(applied,0);mounted.unmount();
});
test('returning controls to their former values does not revive a cancelled busy state',async()=>{
 const pending=deferred();const workspace={scope:{ownerId:'o',libraryId:'l',mode:'local'},settings:{enabled:true,configured:true,model:'mock',provider:'deepseek',revision:1},service:{async *chat(){await pending.promise;yield{type:'delta',text:answer};}}};
 const props={spec,subjects:[],planningStart:'2026-09-09',active:true,disabled:false,onApply(){throw new Error('Cancelled request cannot apply');},currentSourceStamp:()=> 'fixed',onBusyChange(){}};
 const mounted=mount(workspace,props);mounted.start();props.spec={...spec,dailyReviewTarget:21};mounted.render();props.spec=spec;mounted.render();assert.equal(mounted.canGenerate(),true);pending.resolve();await tick();mounted.unmount();
});
