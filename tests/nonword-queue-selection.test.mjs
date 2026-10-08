import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {createNonWordRoundRuntime} from '../src/infrastructure/nonword-study/index.ts';
import {selectNonWordQueueItem,createNonWordQuestionSelection} from '../src/features/nonword-study/queue-selection.ts';

globalThis.indexedDB=new IDBFactory();let serial=0;
async function fixture(){
    const options={scope:{ownerId:`queue-owner-${serial++}`,libraryId:'library',groupId:'group',day:'2026-10-07',cloud:false},
        members:['A','B','C','D','E'].map((itemKey,index)=>({itemKey,snapshotId:'snapshot',contentHash:String(index+1).repeat(64),kind:'practice',mode:'recall'}))};
    const runtime=await createNonWordRoundRuntime(options);return {runtime,options,first:await runtime.read()};
}
const traversal={correctKeys:['A'],wrongKeys:['C'],awaitingReviewKeys:['D'],skippedKeys:['E']};

test('explicit queue selection survives cold recovery without marking the current question traversed',async()=>{
    const {runtime,options,first}=await fixture();
    const selected=await runtime.selectItem('B',first.runId);assert.equal(selected.currentItemKey,'B');
    assert.deepEqual(selected.traversal,first.traversal);assert.equal(selected.runId,first.runId);assert.equal(selected.anchorAttemptId,first.anchorAttemptId);
    const restored=await (await createNonWordRoundRuntime(options)).read();assert.equal(restored.currentItemKey,'B');
    assert.deepEqual(restored.traversal,first.traversal);
    const anchor=await runtime.repository.read(first.anchorAttemptId);assert.equal(anchor.submitted,null);assert.equal(anchor.formal,null);
});

test('selection serializes behind accepted traversal and preserves all four status lists',async()=>{
    const {runtime,first}=await fixture();
    const saved=runtime.saveCursor({currentItemKey:'B',traversal},first.runId);
    const selected=runtime.selectItem('B',first.runId);await saved;
    assert.deepEqual((await selected).traversal,traversal);assert.deepEqual((await runtime.read()).traversal,traversal);
});

test('stale run and foreign queue items cannot replace the reliable current position',async()=>{
    const {runtime,first}=await fixture();await runtime.startNewRound({restartConfirmed:true});const newer=await runtime.read();
    await assert.rejects(runtime.selectItem('B',first.runId),/run-conflict/);
    await assert.rejects(runtime.selectItem('foreign',newer.runId),/unknown-item/);
    assert.equal((await runtime.read()).currentItemKey,newer.currentItemKey);assert.equal((await runtime.read()).runId,newer.runId);
});

test('failed selection does not move the visible question',async()=>{
    let selected=0;
    const round={read:async()=>({runId:'run'}),selectItem:async()=>{throw Error('storage unavailable');}};
    await assert.rejects(selectNonWordQueueItem('B',{current:()=>true,round:async()=>round,select:()=>selected++}),/storage unavailable/);
    assert.equal(selected,0);
});

test('a receipt arriving after a source switch cannot select a question in the new view',async()=>{
    let resolve,start,current=true,selected=0;const receipt=new Promise(done=>{resolve=done;}),started=new Promise(done=>{start=done;});
    const round={read:async()=>({runId:'run'}),selectItem:()=>{start();return receipt;}};
    const pending=selectNonWordQueueItem('B',{current:()=>current,round:async()=>round,select:()=>selected++});
    await started;current=false;resolve({});
    assert.equal(await pending,false);assert.equal(selected,0);
});

test('vocabulary queue selection stays synchronous and never opens a non-word cursor',()=>{
    const navigation={current:3};let selected=-1,reads=0;
    const choose=createNonWordQuestionSelection({enabled:true,original:{mode:'recall',data:{word:'retain',meaning:'保持',eventKind:'word'}},itemKeys:['word'],begin:()=>++navigation.current,latest:request=>navigation.current===request,current:()=>true,
        round:async()=>{reads++;return null;},select:index=>{selected=index;},failure:()=>assert.fail('unexpected error')});
    choose(0);assert.equal(selected,0);assert.equal(reads,0);assert.equal(navigation.current,3);
});
