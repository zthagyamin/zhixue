import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {openD1} from './helpers/sqlite-d1.mjs';
import {D1PracticeEvidenceStore} from '../src/infrastructure/practice-evidence/index.ts';
import {D1LearningAttemptStore} from '../src/infrastructure/learning-attempt/index.ts';
import {AccountStudyAiStore} from '../db/account-study-ai-store.ts';
import {AccountStudyStore} from '../db/account-study-store.ts';
import {courseEvidenceOriginal} from '../src/application/course-study/index.ts';
import {sealStudyItem,sealStudySnapshot} from '../app/account-study-content.ts';
import {quizBody,snapshotBody} from './fixtures/account-study-fixtures.mjs';
import {accountFixture} from './math-account-fixtures.mjs';
import {createAccountStudyApplication} from '../src/application/account-study/index.ts';
import {mutation} from './fixtures/practice-evidence-fixtures.mjs';
async function fixture(t,mode,options={}){
 const f=accountFixture(mode),db=await openD1();t.after(()=>db.sqlite.close());
 if(!db.sqlite.prepare("SELECT name FROM sqlite_master WHERE name='practice_evidence_v1'").get())db.sqlite.exec(readFileSync(new URL('../drizzle/0023_practice_evidence_v1.sql',import.meta.url),'utf8'));db.sqlite.exec("INSERT INTO learning_accounts(user_id) VALUES ('owner')");
 const scope={userId:'owner',libraryId:'library'},study=new AccountStudyStore(db.binding),body=quizBody(options.legacy?{}:{schemaVersion:2,learningSupport:f.item.learningSupport});
 if(options.legacy){f.item.practice.answer=options.reference??'3';f.evidence=null;}
 body.practice={...body.practice,...f.item.practice,domain:'synthetic',sourceLabel:'Synthetic source'};delete body.practice.options;
 if(mode==='code'){body.practice.initialCode='pass';body.practice.testCode='assert twice(2) == 4';}
 const item=await sealStudyItem(body),snapshot=await sealStudySnapshot(snapshotBody([item],{libraryId:scope.libraryId}));await study.putSnapshot(scope,{snapshot,items:[item]},0);
 const binding={...f.a.binding,snapshotId:snapshot.snapshotId,itemKey:item.itemKey,contentHash:item.contentHash};
 f.a.binding=binding;f.item=item;const attempts=new D1LearningAttemptStore(db.binding),original=courseEvidenceOriginal(study,attempts);
 const put=()=>db.sqlite.prepare('INSERT OR REPLACE INTO learning_attempts_v1(user_id,library_id,attempt_id,group_id,revision,attempt_json,updated_at) VALUES (?,?,?,?,?,?,?)').run(scope.userId,scope.libraryId,f.a.attemptId,binding.groupId,f.a.revision,JSON.stringify(f.a),f.a.updatedAt);
 const store=new D1PracticeEvidenceStore(db.binding,original);
 if(mode==='calculation'&&!options.legacy){
  const submitted=f.a.submitted;f.a.submitted=null;put();await store.mutate(scope,{...mutation('step-input',{text:'Multiply rate by elapsed time'}),binding});f.a.submitted=submitted;put();
 }else if(mode==='code'){
  put();const report=f.evidence.execution.latest;report.identity.sourceVersion=report.identity.testVersion=item.contentHash;
  await store.mutate(scope,{...mutation('code-report',{report}),binding});
 }else put();
 f.deps.getStudyStore=async()=>study;f.deps.getAttemptStore=async()=>attempts;
 f.deps.getPracticeEvidenceStore=async(service)=>new D1PracticeEvidenceStore(db.binding,original,{service});
 f.app=createAccountStudyApplication(f.deps);f.math.request.sourceVersion=f.hint.request.sourceVersion=item.contentHash;
 const model=f.model;f.model=async(kind,input,trace)=>{const out=await model(kind,input,trace);if(kind==='math-step')out.output.diagnostic.sourceVersion=item.contentHash;return out;};
 return Object.assign(f,{db,store,scope,item,put});
}
test('actual D1 controlled semantic service approves only prepared output, persists and never changes original formal state',async t=>{
 const f=await fixture(t,'calculation'),before=f.db.sqlite.prepare('SELECT attempt_json FROM learning_attempts_v1').get().attempt_json;
 const r=(await f.send(f.math)).value;assert.equal(r.step.source,'model');assert.equal((await f.store.read(f.scope,'attempt')).calculation.diagnostic.status,'correct');
 assert.equal(f.db.sqlite.prepare('SELECT attempt_json FROM learning_attempts_v1').get().attempt_json,before);
 const forged={...mutation('step-diagnostic',{diagnostic:{...r.step,explanation:'caller forged output'}},2,'forged'),binding:f.a.binding};
 await assert.rejects(f.store.mutate(f.scope,forged),/trusted/);await assert.rejects(f.store.trustedWriter().mutate(f.scope,forged),/model/);
 f.db.sqlite.exec('UPDATE account_study_snapshots SET published=0');await assert.rejects(f.send(f.math));assert.equal(f.calls,1);
});
test('actual D1 controlled code hint service resolves saved report and sidecar hydration',async t=>{
 const f=await fixture(t,'code'),before=f.db.sqlite.prepare('SELECT attempt_json FROM learning_attempts_v1').get().attempt_json;
 const r=(await f.send(f.hint)).value;assert.equal(r.status,'accepted');assert.equal((await f.store.read(f.scope,'attempt')).execution.hint.source,'model');
 assert.equal(f.db.sqlite.prepare('SELECT attempt_json FROM learning_attempts_v1').get().attempt_json,before);assert.equal((await f.send(f.hint)).value.status,'duplicate');assert.equal(f.calls,1);
});

test('actual account AI budget ledger reuses prepared output after sidecar receipt loss',async t=>{
 const f=await fixture(t,'calculation'),ai=new AccountStudyAiStore(f.db.binding,Buffer.alloc(32,5).toString('base64url'));
 await ai.configure(f.scope,{enabled:true,dailyRequestLimit:3,dailyTokenLimit:20000,maxOutputTokens:1000,expectedRevision:0,confirmCosts:true,providerKey:'synthetic-test-key',model:'mock'});f.deps.getAiStore=async()=>ai;
 const getStore=f.deps.getPracticeEvidenceStore;let loss=true;f.deps.getPracticeEvidenceStore=async service=>{const store=await getStore(service);return {supported:()=>store.supported(),read:(...args)=>store.read(...args),trustedWriter:()=>({mutate:async(...args)=>{if(loss){loss=false;throw Error('receipt lost');}return store.trustedWriter().mutate(...args);}})};};
 await assert.rejects(f.send(f.math),/receipt-unknown/);assert.equal(f.calls,1);assert.equal((await f.store.read(f.scope,'attempt')).calculation.diagnostic,undefined);
 assert.equal((await f.send(f.math)).value.step.status,'correct');assert.equal(f.calls,1);
 const rows=f.db.sqlite.prepare('SELECT status,usage_tokens,prompt_version,rule_version FROM account_study_ai_requests').all();assert.equal(rows.length,1);assert.equal(rows[0].status,'completed');assert.equal(rows[0].usage_tokens,10);assert.equal(rows[0].prompt_version,'practice-assistance-v1');assert.equal(rows[0].rule_version,'source-bound-assistance-v1');
});

test('actual D1 legacy numeric final compares complete authoritative original without sidecar or inferred support',async t=>{
 const f=await fixture(t,'calculation',{legacy:true}),before=f.db.sqlite.prepare('SELECT attempt_json FROM learning_attempts_v1').get().attempt_json;
 const r=(await f.send({...f.math,request:{...f.math.request,mode:'final'}})).value;assert.equal(r.final.status,'correct');assert.equal(r.step,undefined);assert.equal(r.evidence,undefined);assert.equal(f.calls,0);assert.equal(await f.store.read(f.scope,'attempt'),null);assert.equal(f.db.sqlite.prepare('SELECT attempt_json FROM learning_attempts_v1').get().attempt_json,before);
 await assert.rejects(f.send({...f.math,request:{...f.math.request,mode:'final',reference:'3'}}));
});

test('actual D1 optional step write loss cannot discard the independently checked final result',async t=>{
 const f=await fixture(t,'calculation'),before=f.db.sqlite.prepare('SELECT attempt_json FROM learning_attempts_v1').get().attempt_json;
 const getStore=f.deps.getPracticeEvidenceStore;
 f.deps.getPracticeEvidenceStore=async service=>{const store=await getStore(service);return {supported:()=>store.supported(),read:(...args)=>store.read(...args),trustedWriter:()=>({mutate:async()=>{throw Error('receipt lost');}})};};
 const r=(await f.send({...f.math,request:{...f.math.request,mode:'final'}})).value;
 assert.equal(r.final.status,'correct');assert.equal(r.step.status,'undetermined');assert.equal(r.step.source,'none');assert.equal(f.calls,0);
 assert.equal((await f.store.read(f.scope,'attempt')).calculation.diagnostic,undefined);
 assert.equal(f.db.sqlite.prepare('SELECT attempt_json FROM learning_attempts_v1').get().attempt_json,before);
});
test('actual D1 legacy unscoped symbolic reference stays pending without overwriting saved answer or formal grade',async t=>{
 const f=await fixture(t,'calculation',{legacy:true,reference:'x+x'}),before=f.db.sqlite.prepare('SELECT attempt_json FROM learning_attempts_v1').get().attempt_json;
 await assert.rejects(f.send({...f.math,request:{...f.math.request,mode:'final'}}),/source-unavailable/);assert.equal(f.calls,0);assert.equal(await f.store.read(f.scope,'attempt'),null);assert.equal(f.db.sqlite.prepare('SELECT attempt_json FROM learning_attempts_v1').get().attempt_json,before);
});
