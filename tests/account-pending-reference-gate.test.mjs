import assert from 'node:assert/strict';
import test from 'node:test';
import {createHooks,loader,nodes} from './helpers/causal-harness.mjs';

function fixture({cloud=true,submitted=null,listedSubmitted=submitted,answer='preserved reference',explanation}={}){
  const hooks=createHooks(),Queue=()=>null;
  let reads=0,writes=0;
  const forbidden=()=>{writes++;throw Error('Unexpected write');};
  const row={attemptId:'reference-gate-draft',binding:{ownerId:'synthetic-owner',libraryId:'synthetic-library',snapshotId:'synthetic-snapshot',itemKey:'practice:synthetic',contentHash:'a'.repeat(64)},submitted:listedSubmitted,checkpoint:{mode:'recall',purpose:'first',view:{paused:true,referenceSeen:false}}};
  const original={attempt:{...row,submitted},referenceVerified:true,resumable:true,item:{kind:'practice',title:'original task',practice:{questionType:'recall',sourceLabel:'original source',prompt:'preserved question',answer,explanation}}};
  const load=loader(hooks.api,{
    'src/infrastructure/math-study/index.ts':{createNativeMathSourceCache:forbidden,createPendingMathStepRuntime:()=>({})},
    'src/features/calculation-study/index.ts':{PendingMathStepQueue:()=>null},
    'src/infrastructure/course-study/index.ts':{createNativeCourseSourceCache:forbidden},
    'src/features/nonword-study/index.ts':{PendingAnswerQueue:Queue},
    'src/infrastructure/nonword-study/index.ts':{createNonWordPendingRuntime:()=>({list:async()=>[row],loadOriginal:async()=>{reads++;return structuredClone(original);}}),cacheOriginalPendingBundle:forbidden},
    'src/infrastructure/learning-attempt/index.ts':{createAccountAttemptClient:()=>({})},
    'app/account-study-content.ts':{},'app/local-account-study.ts':{cacheLocalStudySnapshot:forbidden},
    'app/local-study-db.ts':{loadWorkspaceRecord:forbidden},'app/math-text.tsx':{MathText:()=>null},
    'app/study-dashboard/pending-review.tsx':{PendingAttemptReview:()=>null},
  });
  const {PendingAnswerWorkspace}=load('app/study-dashboard/pending-workspace.tsx');
  hooks.mount(PendingAnswerWorkspace,{workspaceId:cloud?'account:synthetic-owner':'portable:synthetic-owner',ownerId:'synthetic-owner',libraryId:'synthetic-library',cloud,ready:true,records:[],persist:forbidden,sendCloud:forbidden,sendCompanion:forbidden,changed:forbidden});
  const queue=[...nodes(hooks.view())].find(node=>node.type===Queue);
  assert.ok(queue);
  return{row,original,read:()=>queue.props.port.reference(row),reads:()=>reads,writes:()=>writes,close:()=>hooks.unmount()};
}

for(const cloud of [true,false]){
  test(`${cloud?'account':'portable'} unsubmitted recovery keeps prompt but withholds full reference without mutating the draft`,async()=>{
    const f=fixture({cloud}),before=structuredClone(f.row);
    const result=await f.read();
    assert.equal(result.prompt,'preserved question');
    assert.equal(result.sourceLabel,'original source');
    assert.equal(result.reference,undefined);
    assert.deepEqual(f.row,before);assert.equal(f.reads(),1);assert.equal(f.writes(),0);f.close();
  });
}

test('submitted recovery retains the original reference',async()=>{
  const f=fixture({submitted:{answer:'original answer',submittedAt:'2026-10-25T01:00:00Z'}});
  assert.equal((await f.read()).reference,'preserved reference');
  assert.equal(f.writes(),0);f.close();
});

test('a stale listed submitted state cannot reveal a freshly read unsubmitted draft',async()=>{
  const f=fixture({submitted:null,listedSubmitted:{answer:'stale listed answer'}});
  assert.equal((await f.read()).reference,undefined);assert.equal(f.writes(),0);f.close();
});

test('explanation-only source is withheld before submission and retained afterward',async()=>{
  const pending=fixture({answer:null,explanation:'original explanation'});
  assert.equal((await pending.read()).reference,undefined);pending.close();
  const submitted=fixture({submitted:{answer:'original answer'},answer:null,explanation:'original explanation'});
  assert.equal((await submitted.read()).reference,'original explanation');submitted.close();
});

test('unverified original source is still rejected',async()=>{
  const f=fixture();f.original.referenceVerified=false;f.original.notice='source verification failed';
  await assert.rejects(f.read(),/source verification failed/);assert.equal(f.writes(),0);f.close();
});
