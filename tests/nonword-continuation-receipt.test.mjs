import test from 'node:test';
import assert from 'node:assert/strict';
import {createLearningDraftStore} from '../app/learning-draft-store.ts';
import {createSubjectGradeHandler} from '../src/features/study-attempt/subject-grade.ts';

async function fixture(continuationReceipt){
    const store=createLearningDraftStore('continuation-receipt'),draft=store.adapter('item','recall');let current=true,moves=0;
    const handler=createSubjectGradeHandler({mode:'recall',completedStage:0,isDemoMode:true,draft},{
        drafts:store,modeEpoch:()=>0,ownerCurrent:()=>true,canPresent:()=>current,
        prepare:()=>({input:{},frame:{},observation:null}),advance:()=>{moves++;},publishDemo:()=>{},setMessage:()=>{},invalidateView:()=>{},
    });
    await handler('good',{deferAdvance:true,...(continuationReceipt?{continuationReceipt:true}:{})});
    return {draft,moves:()=>moves,retire:()=>{current=false;}};
}

test('non-word continuation reports a rejected old view so the current verified host can resume',async()=>{
    const f=await fixture(true);f.retire();assert.equal(f.draft.continueAfterFeedback(),false);assert.equal(f.moves(),0);
});

test('accepted non-word continuation advances once and cannot reuse the original receipt',async()=>{
    const f=await fixture(true);assert.equal(f.draft.continueAfterFeedback(),true);assert.equal(f.moves(),1);
    assert.equal(f.draft.continueAfterFeedback(),false);assert.equal(f.moves(),1);
});

test('legacy continuation keeps the previous void-callback return convention',async()=>{
    const f=await fixture(false);f.retire();assert.equal(f.draft.continueAfterFeedback(),true);assert.equal(f.moves(),0);
});
