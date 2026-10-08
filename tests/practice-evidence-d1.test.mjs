import test from 'node:test';
import assert from 'node:assert/strict';
import {openD1} from './helpers/sqlite-d1.mjs';
import {D1PracticeEvidenceStore} from '../src/infrastructure/practice-evidence/d1.ts';
import {D1LearningAttemptStore} from '../src/infrastructure/learning-attempt/index.ts';
import {AccountStudyStore} from '../db/account-study-store.ts';
import {courseEvidenceOriginal} from '../src/application/course-study/index.ts';
import {sealStudyItem,sealStudySnapshot} from '../app/account-study-content.ts';
import {quizBody,snapshotBody} from './fixtures/account-study-fixtures.mjs';
import {attempt,mutation,support,report,diagnostic} from './fixtures/practice-evidence-fixtures.mjs';
import {createMappedMathVariant} from '../src/domain/guided-math/index.ts';

async function fixture(t,mode='code',submitted=true,learningSupport=support){
 const db=await openD1();t.after(()=>db.sqlite.close());
 db.sqlite.exec("INSERT INTO learning_accounts(user_id) VALUES ('user-a'),('user-b')");
 const scope={userId:'user-a',libraryId:'library-a'},study=new AccountStudyStore(db.binding);
 const body=quizBody(mode==='calculation'?{schemaVersion:2,learningSupport}:{});
 body.practice={itemId:'item',abilityId:'ability',domain:'synthetic',questionType:mode,prompt:'Synthetic problem',sourceLabel:'Synthetic',answer:'2'};
 if(mode==='code'){body.practice.initialCode='pass';body.practice.testCode='assert True';}
 const item=await sealStudyItem(body),snapshot=await sealStudySnapshot(snapshotBody([item]));
 await study.putSnapshot(scope,{snapshot,items:[item]},0);
 const a=attempt(mode,submitted);a.binding={...a.binding,ownerId:scope.userId,libraryId:scope.libraryId,snapshotId:snapshot.snapshotId,itemKey:item.itemKey,contentHash:item.contentHash};
 const put=next=>db.sqlite.prepare('INSERT OR REPLACE INTO learning_attempts_v1(user_id,library_id,attempt_id,group_id,revision,attempt_json,updated_at) VALUES (?,?,?,?,?,?,?)').run(scope.userId,scope.libraryId,next.attemptId,next.binding.groupId,next.revision,JSON.stringify(next),next.updatedAt);
 put(a);const original=courseEvidenceOriginal(study,new D1LearningAttemptStore(db.binding));
 const store=new D1PracticeEvidenceStore(db.binding,original),m=(kind,extra={},rev=0,id='op')=>({...mutation(kind,extra,rev,id),binding:a.binding});
 const r=report();r.identity.sourceVersion=r.identity.testVersion=item.contentHash;
 return {...db,scope,store,a,put,m,r,item,original};
}
test('actual D1 missing capability, scoped CAS, lost receipt replay and no original writes',async t=>{
 const f=await fixture(t),before=JSON.stringify(f.a),m=f.m('code-report',{report:f.r});
 const values=await Promise.all([f.store.mutate(f.scope,m),f.store.mutate(f.scope,{...m,operationId:'two'})]);
 assert.deepEqual(values.map(r=>r.status).sort(),['accepted','conflict']);
 const winner=values[0].status==='accepted'?m:{...m,operationId:'two'};
 assert.equal((await f.store.mutate(f.scope,winner)).status,'duplicate');
 assert.equal((await f.store.mutate(f.scope,winner)).durable,true);
 assert.equal(await f.store.read({...f.scope,userId:'user-b'},'attempt'),null);
 assert.equal(f.sqlite.prepare('SELECT attempt_json FROM learning_attempts_v1').get().attempt_json,before);
 await assert.rejects(f.store.mutate(f.scope,{...m,binding:{...m.binding,ownerId:'user-b'}}),/scope/);
 f.sqlite.exec('DROP TABLE practice_evidence_v1');assert.equal(await f.store.supported(),false);
 await assert.rejects(f.store.read(f.scope,'attempt'),/unsupported/);
});
test('formal resolution between authority read and SQL commit blocks report',async t=>{
 const f=await fixture(t),prepare=f.binding.prepare.bind(f.binding);let changed=false;
 f.binding.prepare=sql=>{const q=prepare(sql);if(/INSERT INTO practice_evidence_v1/.test(sql)&&!changed){changed=true;f.put({...f.a,revision:3,formal:{eventId:'formal'}});}return q;};
 const receipt=await f.store.mutate(f.scope,f.m('code-report',{report:f.r}));
 assert.equal(receipt.status,'conflict');assert.equal(await f.store.read(f.scope,'attempt'),null);
});
test('step submission race freezes input, pending diagnosis may resolve after formal',async t=>{
 const f=await fixture(t,'calculation',false);
 await f.store.mutate(f.scope,f.m('step-input',{text:'2'}));
 const prepare=f.binding.prepare.bind(f.binding);let changed=false;
 f.binding.prepare=sql=>{const q=prepare(sql);if(/UPDATE practice_evidence_v1/.test(sql)&&!changed){changed=true;f.a={...f.a,revision:3,submitted:{answer:f.a.answer,answerRevision:1,submittedAt:f.a.updatedAt,assistance:'unknown'}};f.put(f.a);}return q;};
 assert.equal((await f.store.mutate(f.scope,f.m('step-input',{text:'3'},1,'edit'))).status,'conflict');
 f.binding.prepare=prepare;
 const d={...diagnostic(),sourceVersion:f.item.contentHash};
 await f.store.mutate(f.scope,f.m('step-diagnostic',{diagnostic:d},1,'pending'));
 f.a={...f.a,revision:4,formal:{eventId:'formal'}};f.put(f.a);
 const resolved={...d,status:'correct',source:'deterministic'};
 assert.equal((await f.store.mutate(f.scope,f.m('step-diagnostic',{diagnostic:resolved},2,'resolve'))).status,'accepted');
 assert.equal(JSON.parse(f.sqlite.prepare('SELECT attempt_json FROM learning_attempts_v1').get().attempt_json).formal.eventId,'formal');
});
test('model writes need actual service resolution, source/answer/child are authoritative and lists paginate',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.store.mutate(f.scope,f.m('code-report',{report:{...f.r,identity:{...f.r.identity,revision:0}}})),/identity/);
 await assert.rejects(f.store.mutate(f.scope,f.m('execution-pointer',{prepared:{instanceId:'child-view',attemptId:'missing'}})),/child/);
 await f.store.mutate(f.scope,f.m('code-report',{report:f.r}));
 const hint=f.m('code-hint',{hint:{runId:1,text:'hint',source:'model'}},1,'model');
 await assert.rejects(f.store.mutate(f.scope,hint),/trusted/);
 await assert.rejects(f.store.trustedWriter().mutate(f.scope,hint),/model/);
 const trusted=new D1PracticeEvidenceStore(f.binding,f.original,{service:{resolveModelHint:async({hint})=>hint}});
 assert.equal((await trusted.trustedWriter().mutate(f.scope,hint)).durable,true);
 const next={...f.a,attemptId:'second'};f.put(next);
 await f.store.mutate(f.scope,{...f.m('code-report',{report:{...f.r,identity:{...f.r.identity,attemptId:'second'}}}),attemptId:'second'});
 const page=await f.store.list(f.scope,{limit:1});assert.equal(page.complete,false);assert.equal(page.nextCursor,'attempt');
 const last=await f.store.list(f.scope,{limit:1,cursor:page.nextCursor});assert.equal(last.complete,true);assert.equal(last.records[0].attemptId,'second');
 f.sqlite.exec('UPDATE account_study_snapshots SET published=0');await assert.rejects(f.store.read(f.scope,'attempt'),/source/);
});
test('full immutable saved code and revision zero govern mapping; malformed stored hydration rejects',async t=>{
 const f=await fixture(t);f.a={...f.a,answer:'first\nsecond',answerRevision:0,submitted:{...f.a.submitted,answer:'first\nsecond',answerRevision:0}};f.put(f.a);
 const r={...f.r,identity:{...f.r.identity,revision:0}};
 await assert.rejects(f.store.mutate(f.scope,f.m('code-report',{report:r})),/answer-mapping/);
 r.mapping.originalLineCount=2;
 assert.equal((await f.store.mutate(f.scope,f.m('code-report',{report:r}))).status,'accepted');
 const saved=await f.store.read(f.scope,'attempt');saved.execution.latest.mapping.originalLineCount=1;
 f.sqlite.prepare('UPDATE practice_evidence_v1 SET evidence_json=?').run(JSON.stringify(saved));
 await assert.rejects(f.store.read(f.scope,'attempt'),/answer-mapping/);
});
async function variantFixture(t) {
 const calculation={...support,variantMappingId:'mapped'},f=await fixture(t,'calculation',true,calculation),mapping={schemaVersion:1,mappingId:'mapped',parentItemKey:f.a.binding.itemKey,parentContentHash:f.a.binding.contentHash,hashKind:'content',templateVersion:1,templateId:'sqrt-sign',sourceConditions:[],parameters:{x:-3}};
 const child={...f.a,attemptId:'variant-child',parentAttemptId:'attempt',answer:'',answerRevision:0,submitted:null,revision:1,checkpoint:{...f.a.checkpoint,phase:'answering',purpose:'remediation'}};f.put(child);
 const mapped=await createMappedMathVariant({parent:mapping,support:calculation,mapping,seed:17}),v=mapped.variant;
 const variant={schemaVersion:1,mappingId:'mapped',...v.parent,templateVersion:1,templateId:v.templateId,seed:v.seed,parameters:v.parameters,variantHash:v.variantHash},m={...f.m('variant',{variant}),attemptId:child.attemptId};
 const store=new D1PracticeEvidenceStore(f.binding,f.original,{mapping:{resolveMapping:async()=>mapping}});
 return {...f,store,child,variantMutation:m};
}
test('D1 variant requires remediation child and pins actual submitted parent without changing first grade',async t=>{
 const f=await variantFixture(t);f.a={...f.a,revision:f.a.revision+1,evaluation:{status:'resolved',rating:'again',correct:false,outcome:'incorrect',source:'deterministic',feedback:'Synthetic original first result',evaluationHash:'c'.repeat(64),referenceHash:f.item.contentHash},formal:{eventId:'first-formal',occurredAt:f.a.updatedAt,evaluationHash:'c'.repeat(64),rating:'again',status:'claimed',coreHash:null,authoritativeRecord:null}};f.put(f.a);
 const before=f.sqlite.prepare('SELECT attempt_json FROM learning_attempts_v1 WHERE attempt_id=?').get('attempt').attempt_json;
 await assert.rejects(f.store.mutate(f.scope,{...f.variantMutation,attemptId:'attempt'}),/variant-remediation/);
 assert.equal((await f.store.mutate(f.scope,f.variantMutation)).status,'accepted');assert.equal((await f.store.read(f.scope,'variant-child')).variant.variantHash,f.variantMutation.variant.variantHash);
 assert.equal(f.sqlite.prepare('SELECT attempt_json FROM learning_attempts_v1 WHERE attempt_id=?').get('attempt').attempt_json,before);
 f.put({...f.a,submitted:null,revision:f.a.revision+1});await assert.rejects(f.store.read(f.scope,'variant-child'),/variant-parent/);
});
test('D1 variant parent and source races are rejected atomically before writing sidecar',async t=>{
 for(const change of ['parent','source']) {
  const f=await variantFixture(t),prepare=f.binding.prepare.bind(f.binding);let changed=false;
  f.binding.prepare=sql=>{const q=prepare(sql);if(/INSERT INTO practice_evidence_v1/.test(sql)&&!changed){changed=true;if(change==='parent')f.put({...f.a,revision:f.a.revision+1,submitted:null});else f.sqlite.exec('UPDATE account_study_snapshots SET published=0');}return q;};
  const receipt=await f.store.mutate(f.scope,f.variantMutation);assert.equal(receipt.status,'conflict');assert.equal(receipt.durable,false);assert.equal(f.sqlite.prepare('SELECT count(*) AS count FROM practice_evidence_v1').get().count,0);
 }
});
