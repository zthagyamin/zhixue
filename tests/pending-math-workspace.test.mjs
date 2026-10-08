import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {fixture as nativeFixture} from './fixtures/native-math-fixtures.mjs';
globalThis.indexedDB=new IDBFactory();
import {createHooks,loader,text,button,nodes,deferred,tick} from './helpers/causal-harness.mjs';
const row={original:{attempt:{submitted:{answer:'4'},formal:{status:'linked'}}},evidence:{attemptId:'original'},title:'Old lesson',sourceLabel:'Original version',prompt:'Calculate 2+2',stepPrompt:'Give intermediate value',stepText:'RAW TWO',canEvaluate:true,notice:'步骤待核对，原最终成绩已保留。'};
async function settle(hooks){for(let index=0;index<5;index++){hooks.flush();await tick();hooks.render();}}
test('actual pending step queue reads without evaluation and opens only explicit source-bound review',async()=>{
 const hooks=createHooks(),load=loader(hooks.api),calls=[];
 const port={list:async()=>{calls.push('list');return {rows:[row],complete:true,notice:''};},load:async id=>{calls.push(['load',id]);return row;},evaluate:async()=>{calls.push('evaluate');return null;}};
 hooks.mount(load('src/features/calculation-study/pending-step.tsx').PendingMathStepQueue,{port,version:0});await settle(hooks);
 assert.match(text(hooks.view()),/RAW TWO/);assert.deepEqual(calls,['list']);button(hooks.view(),'查看保存的步骤').props.onClick();await settle(hooks);
 const review=[...nodes(hooks.view())].find(node=>typeof node.type==='function');assert.equal(review.props.row,row);assert.equal(calls.some(call=>call==='evaluate'),false);hooks.unmount();
});
test('actual readonly step review requires explicit click, suppresses duplicate requests and cancels on leave',async()=>{
 const hooks=createHooks(),load=loader(hooks.api),gate=deferred();let calls=0,signal;
 const port={evaluate:async(_row,current)=>{calls++;signal=current;await gate.promise;return {status:'correct',explanation:'Source agrees'};}};
 hooks.mount(load('src/features/calculation-study/pending-step.tsx').PendingMathStepReview,{row,port,onClose:()=>{},renderMath:value=>value});await settle(hooks);
 assert.equal(calls,0);assert.match(text(hooks.view()),/RAW TWO/);assert.match(text(hooks.view()),/最终成绩保留/);
 const evaluate=button(hooks.view(),'核对这一步').props.onClick;evaluate();evaluate();await settle(hooks);assert.equal(calls,1);
 hooks.unmount();assert.equal(signal.aborted,true);gate.resolve();await tick();
});
test('unavailable source keeps raw step readable and disables only evaluation; incomplete list is explicit',async()=>{
 const hooks=createHooks(),load=loader(hooks.api);
 hooks.mount(load('src/features/calculation-study/pending-step.tsx').PendingMathStepReview,{row:{...row,canEvaluate:false,notice:'原参考暂不可用'},port:{evaluate:async()=>{throw Error('must not evaluate');}},onClose:()=>{}});
 assert.match(text(hooks.view()),/RAW TWO/);assert.equal(button(hooks.view(),'核对这一步').props.disabled,true);assert.equal([...nodes(hooks.view())].some(node=>node.type==='textarea'||node.type==='input'),false);hooks.unmount();
 const queue=createHooks(),qload=loader(queue.api),port={list:async()=>({rows:[],complete:false,notice:'账号步骤列表尚未完整恢复'}),load:async()=>null,evaluate:async()=>null};
 queue.mount(qload('src/features/calculation-study/pending-step.tsx').PendingMathStepQueue,{port,version:0});await settle(queue);assert.match(text(queue.view()),/未完整/);assert.doesNotMatch(text(queue.view()),/当前没有待核对步骤/);assert.ok(button(queue.view(),'重新读取'));queue.unmount();
});
test('owner/port switch hides old raw step immediately and ignores late list response',async()=>{
 const hooks=createHooks(),load=loader(hooks.api),gate=deferred(),old={list:()=>gate.promise},next={list:async()=>({rows:[],complete:true,notice:''})},Component=load('src/features/calculation-study/pending-step.tsx').PendingMathStepQueue;
 hooks.mount(Component,{port:old,version:0});hooks.flush();hooks.render({port:next,version:0});hooks.flush();gate.resolve({rows:[row],complete:true,notice:''});await settle(hooks);assert.doesNotMatch(text(hooks.view()),/RAW TWO/);hooks.unmount();
});

test('actual extra-practice entry forwards NativeMath only for the matching local math identity',async()=>{
 const f=await nativeFixture(),Marker=()=>null,transport={supported:()=>true,evaluate:async()=>assert.fail('Opening does not evaluate')};
 const presentation={
  'app/plugins/index.ts':{registry:{get:()=>({id:'@zhixue/plugin-calculation',renderUI:()=>null})}},
  'app/study-plugin-options.tsx':{StudyPluginOptionsProvider:()=>null,StudyPluginOptionsSlot:()=>null},
  'app/study-guidance.tsx':{StudyGuidanceHelp:()=>null},'app/review-context.tsx':{ReviewContext:()=>null},
  'app/learning-draft.tsx':{LearningDraftBoundary:()=>null,LearningDraftLeaveGuard:()=>null},
  'app/study-item-source.tsx':{StudyItemSource:()=>null},'app/math-text.tsx':{MathText:()=>null},
  'app/calculation-client.ts':{gradeCalculationInWorker:()=>assert.fail('No opening grade')},
  'app/study-dashboard/nonword-plugin-host.tsx':{NonWordPluginHost:Marker},
 };
 const data={id:'calculation',itemId:'calculation',pluginType:'calculation',prompt:f.item.practice.prompt,answer:'4',learningSupport:f.support,contentHash:f.identity.contentHash};
 const local={workspaceId:'extra-math',...f.binding,cloud:false,nativeMathIdentity:f.identity,nativeMathCapture:f.capture};
 for(const scope of [local,{...local,cloud:true},{...local,nativeMathIdentity:undefined}]){
  const hooks=createHooks(),load=loader(hooks.api,presentation,{confirm:()=>false}),snapshot={scopeKey:'extra-math-'+String(scope.cloud)+String(Boolean(scope.nativeMathIdentity)),title:'Math extra',items:[data],modes:['calculation'],sourceModes:['calculation'],recoveryScopes:[scope],source:{title:'Synthetic',scope:'fixture'}};
  hooks.mount(load('app/extra-practice-session.tsx').ExtraPracticeSession,{snapshot,nativeMath:transport,onExit(){},canOpenLocal:true,getObsidianUri:()=>''});
  let card;
  for(let retry=0;retry<30&&!card;retry++){await settle(hooks);card=[...nodes(hooks.view())].find(node=>node.type===Marker);}
  assert.ok(card);assert.equal(card.props.context.nativeMath,!scope.cloud&&scope.nativeMathIdentity?transport:undefined);assert.equal(card.props.context.nonWordScope.contentHash,f.identity.contentHash);assert.equal(card.props.context.nonWordScope.temporary,true);hooks.unmount();
 }
});

test('actual ordinary NativeMath pending review keeps semantic identity, frozen source and protected driver port',async()=>{
 const f=await nativeFixture(),Marker=()=>null,transport={supported:()=>true,evaluate:async()=>assert.fail('Opening cannot evaluate')};
 const hooks=createHooks(),load=loader(hooks.api,{
  'app/plugins/index.ts':{registry:{get:()=>({id:'@zhixue/plugin-calculation',renderUI:()=>null})}},
  'app/learning-draft.tsx':{LearningDraftBoundary:()=>null,LearningDraftLeaveGuard:()=>null},
  'app/components/ai-sidebar/study-ai-workspace.tsx':{StudyAIOfflineContext:()=>null},
  'app/study-dashboard/nonword-plugin-host.tsx':{NonWordPluginHost:Marker},
  'app/calculation-client.ts':{gradeCalculationInWorker:()=>assert.fail('Opening cannot grade')},
 });
 const original={attempt:f.attempt,item:null,nativeMathCapture:f.capture,referenceVerified:true,resumable:true,capability:'complete',notice:''};
 const services={workspaceId:'math-pending',ownerId:f.scope.userId,libraryId:f.scope.libraryId,cloud:false,current:()=>true,records:()=>[],nativeMath:transport};
 hooks.mount(load('app/study-dashboard/pending-review.tsx').PendingAttemptReview,{original,services,deviceId:'',onClose(){}});
 const host=[...nodes(hooks.view())].find(node=>node.type===Marker);assert.ok(host);assert.deepEqual(host.props.recovered,f.attempt);
 assert.equal(host.props.context.nativeMath,transport);assert.deepEqual(host.props.context.nonWordScope.nativeMathCapture,f.capture);assert.equal(host.props.context.nonWordScope.courseReference,undefined);
 assert.equal(host.props.context.contentSource.data.contentHash,f.identity.contentHash);assert.equal(host.props.data.answer,'4');assert.equal(host.props.context.gradeRecall,undefined);hooks.unmount();
});
