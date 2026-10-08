import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {createHooks,loader,nodes,text,tick,deferred} from './helpers/causal-harness.mjs';
import {bindInlineNonWordRound,projectInlineNonWordRound} from '../src/features/nonword-study/inline-round.ts';
import {continueNonWordRound} from '../src/application/nonword-study/index.ts';
import {createNonWordRoundRuntime} from '../src/infrastructure/nonword-study/index.ts';
import * as nonWordRuntime from '../src/infrastructure/nonword-study/index.ts';
import {createLocalAttemptRepository} from '../src/infrastructure/learning-attempt/index.ts';

globalThis.indexedDB=new IDBFactory();
let serial=0;
const items=()=>['A','B','C'].map((id,index)=>({itemId:id,fingerprint:'v1',contentHash:String(index+1).repeat(64),questionType:'quiz',prompt:id,options:['a','b'],answer:'0'}));
function fixture(extra={}){
 const {roundGate,...propsExtra}=extra;
 const hooks=createHooks(),load=loader(hooks.api,{'app/study-guidance.tsx':{StudyGuidanceHelp:()=>null},'app/study-item-source.tsx':{StudyItemSource:()=>null},'app/review-context.tsx':{ReviewContext:()=>null},'app/plugins/index.ts':{registry:{get:()=>({id:'@zhixue/plugin-quiz',renderUI:()=>null})}},'app/math-text.tsx':{MathText:()=>null},...(roundGate?{'src/infrastructure/nonword-study/index.ts':{...nonWordRuntime,createNonWordRoundRuntime:async options=>{await roundGate.promise;return createNonWordRoundRuntime(options);}}}:{})},{confirm:()=>true});
 const owner=`inline-${serial++}`,rows=items(),scopeFor=item=>({workspaceId:owner,ownerId:owner,libraryId:'library',snapshotId:'snapshot',itemKey:item.itemId,contentHash:item.contentHash,groupId:'group',roundId:JSON.stringify(['2026-10-05','inline',null]),cloud:false});
 const done=[],records=[],props={items:rows,nonWordScopeFor:scopeFor,onFinish:s=>done.push(s),onRecordAttempt:async(p,c)=>{records.push(p);c.durable();},...propsExtra};
 const binding=bindInlineNonWordRound(rows,scopeFor);
 const runtime=()=>createNonWordRoundRuntime({scope:{ownerId:owner,libraryId:'library',groupId:JSON.stringify(['group',scopeFor(rows[0]).roundId]),day:binding.scope.day,cloud:false},members:binding.scope.members});
 hooks.mount(load('app/practice-session.tsx').PracticeSession,props);
 return{hooks,props,rows,scopeFor,binding,runtime,done,records,plugin:()=>[...nodes(hooks.view())].find(n=>n.props.onGrade&&n.props.context),description:()=>text(hooks.view())};
}
async function settle(f){
 for(let i=0;i<12;i++){f.hooks.flush();await tick();f.hooks.render();}
 const loading=()=>text(f.hooks.view()).includes('正在恢复本题组的作答与当前位置');
 const deadline=Date.now()+10000;
 while(loading()&&Date.now()<deadline){f.hooks.flush();await tick();f.hooks.render();}
 assert.equal(loading(),false,'Round initialization did not acknowledge its saved state');
}

test('round fixture waits for the real initialization reply before reading plugin props',async t=>{
 const gate=deferred(),f=fixture({roundGate:gate});t.after(()=>{gate.resolve();f.hooks.unmount();});
 let finished=false;const ready=settle(f).then(()=>{finished=true;});
 for(let i=0;i<24;i++){f.hooks.flush();await tick();f.hooks.render();}
 assert.equal(f.plugin(),undefined);assert.equal(finished,false,'Restore helper must still await the round receipt');
 gate.resolve();await ready;assert.equal(f.plugin().props.data.itemId,'A');assert.equal(f.records.length,0);
});

test('inline adapter excludes words, temporary, missing day, source mismatches and mixed owners',()=>{
 const f=fixture();assert.ok(f.binding);assert.equal(f.binding.scope.day,'2026-10-05');
 assert.equal(bindInlineNonWordRound(f.rows,f.scopeFor,true),null);
 assert.equal(bindInlineNonWordRound([{...f.rows[0],word:'tree'}],f.scopeFor),null);
 assert.equal(bindInlineNonWordRound(f.rows,item=>({...f.scopeFor(item),roundId:'round'})),null);
 assert.equal(bindInlineNonWordRound(f.rows,item=>({...f.scopeFor(item),contentHash:'f'.repeat(64)})),null);
 assert.equal(bindInlineNonWordRound([{...f.rows[0],contentHash:'invalid'}],f.scopeFor),null);
 assert.equal(bindInlineNonWordRound(f.rows,item=>({...f.scopeFor(item),ownerId:item.itemId})),null);f.hooks.unmount();
});

test('real saved cursor restores B with wrong and pending in separate categories before rendering a plugin',async()=>{
 const f=fixture(),round=await f.runtime();
 await continueNonWordRound(round,'A','pending');
 await settle(f);assert.equal(f.plugin().props.data.itemId,'B');assert.match(f.description(),/待核对 1/);assert.match(f.description(),/待复习 0/);
 assert.equal(f.records.length,0);
 const supplied=await f.plugin().props.round();assert.equal((await supplied.read()).anchorAttemptId,(await round.read()).anchorAttemptId);
 assert.equal(f.plugin().props.context.nonWordScope.members.length,3);f.hooks.unmount();
});

test('explicit continue projects the real durable round after one canonical grade, and remount restores C',async()=>{
 const f=fixture();await settle(f);const first=f.plugin(),round=await first.props.round();
 await first.props.onGrade('again',{deferAdvance:true});await settle(f);assert.equal(f.plugin().props.data.itemId,'A');assert.equal(f.records.length,1);
 // The public production host performs this operation before invoking its draft continuation.
 await continueNonWordRound(round,'A','again');first.props.context.draft.continueAfterFeedback();await settle(f);
 assert.equal(f.plugin().props.data.itemId,'B');assert.match(f.description(),/待复习 1/);
 const second=f.plugin();await continueNonWordRound(round,'B','pending');await second.props.context.nonWordNavigation.continuePending();await settle(f);
 assert.equal(f.plugin().props.data.itemId,'C');assert.match(f.description(),/待复习 1/);assert.match(f.description(),/待核对 1/);
 f.hooks.unmount();
 const hooks=createHooks(),load=loader(hooks.api,{'app/plugins/index.ts':{registry:{get:()=>({renderUI:()=>null})}}});hooks.mount(load('app/practice-session.tsx').PracticeSession,f.props);
 await settle({hooks});const plugin=[...nodes(hooks.view())].find(n=>n.props.onGrade&&n.props.context);assert.equal(plugin.props.data.itemId,'C');assert.equal(f.records.length,1);hooks.unmount();
});

test('completed recovered pass never reopens A or invents formal grades for pending/skipped',async()=>{
 const f=fixture(),round=await f.runtime();await continueNonWordRound(round,'A','again');await continueNonWordRound(round,'B','pending');await continueNonWordRound(round,'C','skipped');
 await settle(f);assert.equal(f.plugin(),undefined);assert.match(f.description(),/本轮已练/);assert.match(f.description(),/已答 1/);assert.match(f.description(),/待核对 1/);assert.match(f.description(),/暂时跳过 1/);
 assert.equal(f.done.length,0);assert.equal(f.records.length,0);f.hooks.unmount();
});

test('skip waits for actual cursor persistence and a failed save retains the original input',async()=>{
 const f=fixture();await settle(f);const plugin=f.plugin(),round=await plugin.props.round(),wait=deferred(),actual=round.saveCursor;
 void wait.promise.catch(()=>{});
 plugin.props.context.draft.write('answer','My original input');round.saveCursor=async input=>{await wait.promise;return actual(input);};
 plugin.props.context.contentNavigation.onSkip();plugin.props.context.contentNavigation.onSkip();await tick();f.hooks.render();assert.equal(f.plugin().props.data.itemId,'A');
 wait.reject(Error('synthetic disk failure'));await settle(f);assert.match(f.description(),/synthetic disk failure/);assert.equal(plugin.props.context.draft.read('answer',''),'My original input');assert.equal((await round.read()).currentItemKey,'A');
 round.saveCursor=actual;[...nodes(f.hooks.view())].find(n=>n.type==='button'&&text(n)==='重试恢复题组').props.onClick();await settle(f);assert.equal(f.plugin().props.data.itemId,'A');f.hooks.unmount();
});

test('changed owner/source ignores a late old cursor response',async()=>{
 const f=fixture();await settle(f);const old=f.plugin(),round=await old.props.round(),read=round.read,wait=deferred();round.read=()=>wait.promise;
 old.props.context.nonWordNavigation.continuePending();await tick();
 const nextRows=f.rows.map(row=>({...row,contentHash:'e'.repeat(64)})),newScope=item=>({...f.scopeFor(item),ownerId:'new-owner',workspaceId:'new-owner',snapshotId:'new-source'});
 f.hooks.render({...f.props,items:nextRows,nonWordScopeFor:newScope});await settle(f);assert.equal(f.plugin().props.context.nonWordScope.ownerId,'new-owner');
 wait.resolve({...await read(),currentItemKey:'C'});await settle(f);assert.equal(f.plugin().props.data.itemId,'A');assert.equal(f.plugin().props.context.nonWordScope.snapshotId,'new-source');f.hooks.unmount();
});

test('projection rejects different source members rather than borrowing their counts',async()=>{
 const f=fixture(),round=await f.runtime(),state=await round.read();assert.throws(()=>projectInlineNonWordRound(f.binding,{...state,members:[{...state.members[0],snapshotId:'other'}]}),/来源版本/);f.hooks.unmount();
});

test('actual inline bridge and shared Host save a pending answer and cursor before advancing; cursor failure preserves A',async t=>{
 const f=fixture();await settle(f);const original=f.plugin(),boundHooks=createHooks(),hostHooks=createHooks();let handles;
 const boundLoad=loader(boundHooks.api),hostLoad=loader(hostHooks.api);
 const outer=boundLoad('app/study-dashboard/nonword-plugin-host.tsx').NonWordPluginHost({...original.props,
   plugin:{id:'@zhixue/plugin-quiz',renderUI:props=>{handles=props;return null;}}});
 boundHooks.mount(outer.type,outer.props);hostHooks.mount(hostLoad('src/features/nonword-study/host.tsx').NonWordStudyHost,boundHooks.view().props);
 t.after(()=>{hostHooks.unmount();boundHooks.unmount();f.hooks.unmount();});
 const settleHost=async()=>{const deadline=Date.now()+15000;do{hostHooks.flush();await tick();hostHooks.render();for(const node of nodes(hostHooks.view()))if(typeof node.type==='function'&&typeof node.props.renderPlugin==='function'){const child=node.type(node.props);if(typeof child?.type==='function')child.type(child.props);}if(handles?.context.nonWordLearning.ready){hostHooks.flush();return;}}while(Date.now()<deadline);assert.fail('Actual inline host did not finish its durable bootstrap');};
 await settleHost();assert.ok(handles);const lifecycle=handles.context.nonWordLearning;
 handles.context.draft.write('selected','a');await lifecycle.submit('My immutable original answer');await lifecycle.waitForReview('AI connection unavailable');
 const group=await original.props.round(),actual=group.saveCursor;group.saveCursor=async()=>{throw Error('cursor disk unavailable');};
 await assert.rejects(lifecycle.continuePending(),/cursor disk unavailable/);await settle(f);assert.equal(f.plugin().props.data.itemId,'A');assert.equal((await group.read()).currentItemKey,'A');
 group.saveCursor=actual;await lifecycle.continuePending();await settle(f);assert.equal(f.plugin().props.data.itemId,'B');assert.deepEqual((await group.read()).traversal.awaitingReviewKeys,['A']);assert.match(f.description(),/待复习 0/);assert.match(f.description(),/待核对 1/);
 const repo=createLocalAttemptRepository({userId:f.binding.scope.ownerId,libraryId:'library'}),row=(await repo.list()).find(row=>row.submitted?.answer==='My immutable original answer');
 assert.ok(row);assert.equal(row.formal,null);assert.equal(f.records.length,0);
});
