import test from 'node:test';
import assert from 'node:assert/strict';
import {createNonWordExecutionCoordinator} from '../src/application/nonword-study/execution.ts';
import {createNonWordSession} from '../src/application/nonword-study/session.ts';
import {applyAttemptMutation} from '../src/domain/learning-attempt/index.ts';
import {attemptFingerprint,evaluationFingerprint} from '../src/infrastructure/learning-attempt/index.ts';

const binding={ownerId:'code-owner',libraryId:'code-library',snapshotId:'code-snapshot',itemKey:'code-item',contentHash:'a'.repeat(64),groupId:'code-group',roundId:'code-round'};
async function fixture({submitted=true}={}){
    const rows=new Map(),children=[];
    let instance,failChild=false,failPointer=false,failDraft=false;
    const repository={read:async id=>rows.get(id)??null,mutate:async mutation=>{
        if(failDraft&&mutation.attemptId==='first'&&mutation.kind==='checkpoint')throw Error('editor draft storage failed');
        if(failChild&&mutation.attemptId!=='first')throw Error('child storage failed');
        const receipt=applyAttemptMutation(rows.get(mutation.attemptId)??null,mutation);
        if(receipt.status!=='conflict')rows.set(mutation.attemptId,receipt.attempt);
        return {...receipt,durable:receipt.status!=='conflict'};
    }};
    async function runtime(id,purpose='first',parentAttemptId){
        const session=createNonWordSession({repository,binding,attemptId:id,formalEventId:`event-${id}`,mode:'code',purpose,parentAttemptId,newId:()=>crypto.randomUUID(),now:()=>new Date().toISOString(),fingerprint:attemptFingerprint,evaluationFingerprint});
        await session.open();return {session,purpose,afterWrite:async()=>{},status:async()=>''};
    }
    const first=await runtime('first');if(submitted)await first.session.submit('original');
    let current=first;
    const create=()=>createNonWordExecutionCoordinator({current:()=>current,primary:()=>first,newId:()=>crypto.randomUUID(),readInstance:()=>instance,
        rememberInstance:async(_,value)=>{if(failPointer)throw Error('pointer storage failed');instance=value;},
        createChild:async(parent,id)=>{children.push(id);return runtime(`child:${id}`,'remediation',parent);}});
    return {first,rows,children,create,runtime,setCurrent:value=>{current=value;},failChild:()=>{failChild=true;},failPointer:()=>{failPointer=true;},failDraft:()=>{failDraft=true;}};
}

test('pending original code reuses the saved first answer revision',async()=>{
    const f=await fixture(),identity=await f.create().prepare('original');
    assert.equal(identity.attemptId,'first');assert.equal(identity.revision,f.first.session.snapshot().submitted.answerRevision);
    assert.equal(f.children.length,0);
});
test('changed code is durably submitted before execution and its outcome cannot overwrite first failure',async()=>{
    const f=await fixture();await f.first.session.assess({status:'incorrect',source:'deterministic',rating:'again',explanation:'first failure'});
    const coordinator=f.create(),identity=await coordinator.prepare('fixed');
    const child=f.rows.get(identity.attemptId);assert.equal(child.submitted.answer,'fixed');assert.equal(child.parentAttemptId,'first');
    assert.equal(f.rows.get('first').checkpoint.pluginFields.code,'fixed');
    await coordinator.recordRemediation('fixed',{status:'correct',source:'deterministic',explanation:'public checks passed'});
    assert.equal(f.first.session.snapshot().submitted.answer,'original');assert.equal(f.first.session.snapshot().evaluation.rating,'again');
    assert.equal(f.rows.get(identity.attemptId).evaluation.outcome,'correct');assert.equal(f.children.length,1);
});
test('saved editor code precedes execution and a later intentional return to first code survives recovery',async()=>{
    const f=await fixture();await f.create().prepare('fixed');
    assert.equal(f.rows.get('first').checkpoint.pluginFields.code,'fixed');
    await f.first.session.save('original',{code:'newer edit'});
    await f.first.session.save('original',{code:'original'});
    const reopened=await f.runtime('first');
    assert.equal(reopened.session.snapshot().checkpoint.pluginFields.code,'original');
    assert.equal(reopened.session.snapshot().submitted.answer,'original');
});
test('editor draft receipt failure blocks execution before a child can be created',async()=>{
    const f=await fixture();f.failDraft();await assert.rejects(f.create().prepare('fixed'),/editor draft storage failed/);
    assert.equal(f.children.length,0);assert.equal(f.rows.size,1);assert.equal(f.rows.get('first').submitted.answer,'original');
});
test('refresh recovers the same pending execution child rather than making another attempt',async()=>{
    const f=await fixture(),first=await f.create().prepare('different'),restored=await f.create().prepare('different');
    assert.deepEqual(restored,first);assert.equal(f.rows.size,2);
});
test('a failed child save or failed recovery-pointer save blocks execution preparation',async()=>{
    const f=await fixture();f.failChild();await assert.rejects(f.create().prepare('different'),/storage failed/);
    const next=await fixture();next.failPointer();await assert.rejects(next.create().prepare('different'),/pointer storage failed/);
});

test('guided execution and repair do not require or submit an independent first answer',async()=>{
    const f=await fixture({submitted:false}),guided=await f.runtime('guided','guided');
    await guided.session.submit('guided answer','observed');f.setCurrent(guided);
    const coordinator=f.create();assert.equal((await coordinator.prepare('guided answer')).attemptId,'guided');
    await guided.session.assess({status:'incorrect',source:'deterministic',rating:'again',explanation:'guided failure'});
    const repaired=await coordinator.prepare('guided correction');
    assert.equal(f.rows.get(repaired.attemptId).parentAttemptId,'guided');
    await coordinator.recordRemediation('guided correction',{status:'correct',source:'deterministic',explanation:'guided checks passed'});
    assert.equal(f.first.session.snapshot().submitted,null);assert.equal(f.first.session.snapshot().formal,null);
});
