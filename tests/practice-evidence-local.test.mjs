import test from 'node:test';
import assert from 'node:assert/strict';
import {indexedDB} from 'fake-indexeddb';
import {createLocalPracticeEvidenceRepository} from '../src/infrastructure/practice-evidence/index.ts';
import {report,binding,diagnostic} from './fixtures/practice-evidence-fixtures.mjs';
import {fixture} from './fixtures/practice-evidence-local-fixtures.mjs';
import {realSessionFixture} from './fixtures/practice-evidence-real-session-fixtures.mjs';
import {resolvePracticeEvidenceAuthority} from '../src/application/practice-evidence/index.ts';
import {applyPracticeEvidenceMutation} from '../src/domain/practice-evidence/index.ts';
import {createMappedMathVariant} from '../src/domain/guided-math/index.ts';
import {support} from './fixtures/practice-evidence-fixtures.mjs';
globalThis.indexedDB=indexedDB;
test('durable CAS across real IndexedDB instances keeps raw attempt isolated and survives refresh',async()=>{
 const f=fixture(),before=structuredClone(f.a),one=f.m('code-report',{report:report()});
 const peer=createLocalPracticeEvidenceRepository(f.scope,f.attempts);
 const receipts=await Promise.all([f.repo.mutate(one),peer.mutate({...one,operationId:'peer',report:report(2)})]);
 assert.deepEqual(receipts.map(r=>r.status).sort(),['accepted','conflict']);assert.equal(receipts.find(r=>r.status==='accepted').durable,true);
 const reload=createLocalPracticeEvidenceRepository(f.scope,f.attempts);assert.equal((await reload.read('attempt')).revision,1);assert.equal((await reload.pending()).length,1);
 assert.equal((await reload.mutate(one)).status,receipts[0].status==='accepted'?'duplicate':'conflict');
 assert.equal(await createLocalPracticeEvidenceRepository({...f.scope,libraryId:'other'},f.attempts).read('attempt'),null);
 assert.equal(await createLocalPracticeEvidenceRepository({ownerId:'different',libraryId:f.scope.libraryId},f.attempts).read('attempt'),null);
 assert.deepEqual(f.a,before);
});
test('transaction failure rolls back record and outbox, missing storage never pretends durable',async()=>{
 const f=fixture();let aborted=false;
 const broken=createLocalPracticeEvidenceRepository(f.scope,f.attempts,{beforeCommit:tx=>{aborted=true;tx.abort();}});
 await assert.rejects(broken.mutate(f.m('code-report',{report:report()})),/aborted/);assert.equal(aborted,true);
 assert.equal(await f.repo.read('attempt'),null);assert.deepEqual(await f.repo.pending(),[]);
 const db=globalThis.indexedDB;delete globalThis.indexedDB;
 try{await assert.rejects(f.repo.mutate(f.m('code-report',{report:report()})),/unavailable/);}finally{globalThis.indexedDB=db;}
});
test('source edits reject stored steps and malformed hydration; submitted child pointer is mandatory',async()=>{
 const f=fixture('calculation',false);await f.repo.mutate(f.m('step-input',{text:'2'}));
 f.a.binding.contentHash='b'.repeat(64);await assert.rejects(f.repo.read('attempt'),/binding/);
 const c=fixture();await assert.rejects(c.repo.mutate(c.m('execution-pointer',{prepared:{instanceId:'instance',attemptId:'child'}})),/pointer/);
 const child={...c.a,attemptId:'child',parentAttemptId:'attempt'};
 const port={...c.attempts,readAttempt:async id=>id==='child'?structuredClone(child):c.attempts.readAttempt(id)};
 const repo=createLocalPracticeEvidenceRepository(c.scope,port);await repo.mutate(c.m('execution-pointer',{prepared:{instanceId:'instance',attemptId:'child'}}));
 assert.equal((await repo.read('attempt')).execution.prepared.attemptId,'child');
 child.submitted=null;await assert.rejects(repo.read('attempt'),/pointer/);
 await assert.rejects(repo.hydrate({schemaVersion:2,attemptId:'attempt'}));
 assert.equal(binding.ownerId,'owner');
});
test('original answer stays saved when sidecar fails; model diagnosis needs explicit repository service port',async()=>{
 const f=fixture('calculation',false);await f.repo.mutate(f.m('step-input',{text:'2'}));f.a.submitted={answer:f.a.answer,answerRevision:1,submittedAt:f.a.updatedAt,assistance:'unknown'};f.a.formal={status:'linked'};
 const before=structuredClone(f.a),m=f.m('step-diagnostic',{diagnostic:diagnostic('correct','model')},1,'model');
 await assert.rejects(f.repo.mutate(m),/model-write-port/);
 const trusted=createLocalPracticeEvidenceRepository(f.scope,f.attempts,{service:{resolveModelDiagnostic:async({diagnostic})=>diagnostic}});
 const r=await trusted.mutate(m);assert.equal(r.record.calculation.diagnostic.status,'correct');assert.equal(r.durable,true);
 assert.deepEqual(f.a,before);assert.equal((await trusted.mutate(m)).status,'duplicate');
 const changed={...m,operationId:'model-change',expectedRevision:2,diagnostic:{...m.diagnostic,status:'incorrect'}};assert.equal((await trusted.mutate(changed)).status,'conflict');
});
test('full stdout and traceback survive actual IndexedDB refresh with immutable first output',async()=>{
 const f=fixture(),raw=structuredClone(f.a),output='stdout: result\nTraceback (most recent call last):\n  File "<learner>", line 1\nValueError: full detail\n';
 const m=f.m('code-report',{report:report(7),output});await f.repo.mutate(m);
 const fresh=createLocalPracticeEvidenceRepository(f.scope,f.attempts),restored=await fresh.read('attempt');
 assert.equal(restored.execution.firstOutput,output);assert.equal(restored.execution.latestOutput,output);assert.deepEqual(restored.binding,f.a.binding);
 const updated=await fresh.mutate(f.m('code-report',{report:report(1),output:'later stdout and error'},1,'later'));
 assert.equal(updated.record.execution.firstOutput,output);assert.equal(updated.record.execution.latestOutput,'later stdout and error');
 assert.equal((await fresh.mutate(m)).status,'duplicate');
 assert.equal((await fresh.mutate({...m,output:'rewritten original'})).status,'conflict');
 await assert.rejects(fresh.mutate(f.m('code-report',{report:report(2),output:'x'.repeat(20001)},2,'oversized')),/text/);
 assert.equal((await fresh.read('attempt')).revision,2);assert.deepEqual(f.a,raw);
 const absent=fixture();await absent.repo.mutate(absent.m('code-report',{report:report()}));
 const oldStyle=await createLocalPracticeEvidenceRepository(absent.scope,absent.attempts).read('attempt');
 assert.equal(Object.hasOwn(oldStyle.execution,'firstOutput'),false);assert.equal(Object.hasOwn(oldStyle.execution,'latestOutput'),false);
 await absent.repo.mutate(absent.m('code-report',{report:report(2),output:'newer only'},1,'newer'));
 const noFabrication=await absent.repo.read('attempt');assert.equal(Object.hasOwn(noFabrication.execution,'firstOutput'),false);assert.equal(noFabrication.execution.latestOutput,'newer only');
 await absent.repo.mutate(absent.m('code-report',{report:report(3)},2,'without-output'));assert.equal(Object.hasOwn((await absent.repo.read('attempt')).execution,'latestOutput'),false);
});
test('full output honors aggregate UTF8 cap visibly and leaves prior durable evidence intact',async()=>{
 const f=fixture();await f.repo.mutate(f.m('code-report',{report:report(),output:'original details'}));
 const hugeReport={...report(2),exception:{kind:'ValueError',message:'错'.repeat(4000),isAssertion:false}};
 const large=fixture();await assert.rejects(large.repo.mutate(large.m('code-report',{report:hugeReport,output:'中'.repeat(20000)})),/size/);
 assert.equal(await large.repo.read('attempt'),null);assert.deepEqual(await large.repo.pending(),[]);
 await assert.rejects(f.repo.mutate(f.m('code-report',{report:hugeReport,output:'x'.repeat(20001)},1,'over')),/text/);
 assert.equal((await f.repo.read('attempt')).execution.firstOutput,'original details');
 const capped=fixture(),firstOutput='中'.repeat(20000);await capped.repo.mutate(capped.m('code-report',{report:report(),output:firstOutput}));
 await assert.rejects(capped.repo.mutate(capped.m('code-report',{report:hugeReport,output:'文'.repeat(20000)},1,'aggregate-overflow')),/size/);
 const retained=await createLocalPracticeEvidenceRepository(capped.scope,capped.attempts).read('attempt');assert.equal(retained.execution.firstOutput,firstOutput);assert.equal(retained.execution.latestOutput,firstOutput);assert.equal(retained.revision,1);assert.equal((await capped.repo.pending()).length,1);
});
test('actual fresh non-word draft saves optional steps before final answer; empty submit retains legal zero revision',async()=>{
 const f=realSessionFixture('calculation'),fresh=await f.session.open();assert.equal(fresh.answerRevision,0);assert.equal(fresh.submitted,null);
 const step=await f.repo.mutate(f.m('step-input',{text:'2'}));assert.equal(step.status,'accepted');assert.equal((await f.originals.read('attempt')).answer,'');
 const submitted=await f.session.submit('');assert.equal(submitted.submitted.answerRevision,0);
 const checked=await f.repo.mutate(f.m('step-diagnostic',{diagnostic:{...diagnostic('correct','deterministic'),answerRevision:0}},1,'diagnose'));
 assert.equal(checked.status,'accepted');assert.equal(checked.record.calculation.diagnostic.answerRevision,0);
 assert.equal((await createLocalPracticeEvidenceRepository(f.scope,f.attempts).read('attempt')).calculation.stepInput.text,'2');
});
test('actual unchanged empty code submission attaches exact zero-revision execution evidence',async()=>{
 const f=realSessionFixture(),fresh=await f.session.open();assert.equal(fresh.answerRevision,0);await f.session.submit('');
 const code={...report(),identity:{...report().identity,revision:0}},r=await f.repo.mutate(f.m('code-report',{report:code,output:'empty program output'}));assert.equal(r.status,'accepted');assert.equal(r.record.execution.first.identity.revision,0);
 assert.equal((await f.originals.read('attempt')).submitted.answerRevision,0);
});
test('retargeting latest navigation preserves both actual submitted children and independent first reports',async()=>{
 const f=realSessionFixture();await f.session.open();await f.session.submit('parent code');
 await f.repo.mutate(f.m('code-report',{report:report(),output:'parent first'}));
 const one=f.makeSession('child-one','attempt'),two=f.makeSession('child-two','attempt');await one.open();await one.submit('first changed code');await two.open();await two.submit('second changed code');
 const childReport=id=>({...report(),identity:{...report().identity,attemptId:id}});
 for(const id of ['child-one','child-two']) await f.repo.mutate({...f.m('code-report',{report:childReport(id),output:`first ${id}`},0,`report-${id}`),attemptId:id});
 const before=await Promise.all(['attempt','child-one','child-two'].map(id=>f.originals.read(id)));
 await f.repo.mutate(f.m('execution-pointer',{prepared:{instanceId:'instance-one',attemptId:'child-one'}},1,'pointer-one'));
 const retarget=await f.repo.mutate(f.m('execution-pointer',{prepared:{instanceId:'instance-two',attemptId:'child-two'}},2,'pointer-two'));assert.equal(retarget.status,'accepted');assert.equal(retarget.record.execution.prepared.attemptId,'child-two');assert.equal(retarget.record.execution.firstOutput,'parent first');
 const stale=await f.repo.mutate(f.m('execution-pointer',{prepared:{instanceId:'instance-one',attemptId:'child-one'}},2,'stale-pointer'));assert.equal(stale.status,'conflict');
 const refreshed=createLocalPracticeEvidenceRepository(f.scope,f.attempts);assert.equal((await refreshed.read('attempt')).execution.prepared.attemptId,'child-two');
 for(const id of ['child-one','child-two']) assert.equal((await refreshed.read(id)).execution.firstOutput,`first ${id}`);
 assert.deepEqual(await Promise.all(['attempt','child-one','child-two'].map(id=>f.originals.read(id))),before);
 const wrong=f.makeSession('wrong-parent');await wrong.open();await wrong.submit('not a child');
 await assert.rejects(f.repo.mutate(f.m('execution-pointer',{prepared:{instanceId:'wrong-instance',attemptId:'wrong-parent'}},3,'wrong-parent-pointer')),/child-pointer/);
 const changedBinding={...f.binding,contentHash:'b'.repeat(64)},wrongSource={...(await f.originals.read('child-two')),attemptId:'wrong-source',binding:changedBinding};
 const mismatched=createLocalPracticeEvidenceRepository(f.scope,{...f.attempts,readAttempt:id=>id==='wrong-source'?Promise.resolve(wrongSource):f.attempts.readAttempt(id)});
 await assert.rejects(mismatched.mutate(f.m('execution-pointer',{prepared:{instanceId:'wrong-source-instance',attemptId:'wrong-source'}},3,'wrong-source-pointer')),/child-pointer/);
 const current=await refreshed.read('attempt'),hint=f.m('code-hint',{hint:{runId:1,text:'retained hint',source:'preset'}},3,'after-pointer');
 const authority=await resolvePracticeEvidenceAuthority(f.scope,f.attempts,hint,undefined,current);
 assert.equal(authority.currentPreparedChild.attemptId,'child-two');assert.equal(authority.preparedChild.attemptId,'child-two');
 assert.equal((await applyPracticeEvidenceMutation(current,hint,authority)).status,'accepted');
 assert.equal((await f.repo.mutate(hint)).status,'accepted');
});
test('new repository refresh cannot expose old preset or model hint for changed same-ID report',async()=>{
 for(const hintSource of ['preset','model']) {
  const f=fixture(),first={...report(1,'student-error'),phase:'tests',assertionsExecuted:1,exception:{kind:'AssertionError',message:'original case failure',isAssertion:true,location:{origin:'tests',file:'<题目测试>',line:1}},firstFailure:{caseId:'case',functionName:'f',args:[1],kwargs:{},expected:2,actual:3}};
  const hint={runId:1,caseId:'case',text:'old hint for actual 3',source:hintSource},options={service:{resolveModelHint:async({hint})=>hint}};
  const repo=createLocalPracticeEvidenceRepository(f.scope,f.attempts,options);await repo.mutate(f.m('code-report',{report:first,output:'original full trace'}));await repo.mutate(f.m('code-hint',{hint},1,'saved-hint'));
  const refreshed=createLocalPracticeEvidenceRepository(f.scope,f.attempts,options);assert.deepEqual((await refreshed.read('attempt')).execution.hint,hint);
  const changed={...first,exception:{...first.exception,message:'new failure after page refresh'},firstFailure:{...first.firstFailure,actual:4}};
  await refreshed.mutate(f.m('code-report',{report:changed,output:'new full trace'},2,'after-refresh'));
  const restored=await createLocalPracticeEvidenceRepository(f.scope,f.attempts,options).read('attempt');assert.equal(restored.execution.hint,undefined,hintSource);assert.deepEqual(restored.execution.first,first);assert.equal(restored.execution.firstOutput,'original full trace');assert.deepEqual(restored.execution.latest,changed);assert.equal(restored.execution.latestOutput,'new full trace');
 }
});
test('variant hydration belongs only to a genuine remediation child with a submitted source-bound parent',async()=>{
 const f=realSessionFixture('calculation');await f.session.open();await f.session.submit('2');
 const child=f.makeSession('variant-child','attempt');await child.open();
 const calculation={...support,variantMappingId:'mapped'},mapping={schemaVersion:1,mappingId:'mapped',parentItemKey:f.binding.itemKey,parentContentHash:f.binding.contentHash,hashKind:'content',templateVersion:1,templateId:'sqrt-sign',sourceConditions:[],parameters:{x:-3}};
 const attempts={...f.attempts,resolveSource:async()=>({binding:f.binding,calculation,mapping})},mapped=await createMappedMathVariant({parent:mapping,support:calculation,mapping,seed:17}),v=mapped.variant;
 const variant={schemaVersion:1,mappingId:'mapped',...v.parent,templateVersion:1,templateId:v.templateId,seed:v.seed,parameters:v.parameters,variantHash:v.variantHash},repo=createLocalPracticeEvidenceRepository(f.scope,attempts),m={...f.m('variant',{variant}),attemptId:'variant-child'};
 const before=await f.originals.read('attempt');assert.equal((await repo.mutate(m)).status,'accepted');assert.deepEqual(await f.originals.read('attempt'),before);
 const saved=await repo.read('variant-child'),hydrated=createLocalPracticeEvidenceRepository(f.scope,attempts);assert.equal((await hydrated.read('variant-child')).variant.variantHash,variant.variantHash);
 await assert.rejects(repo.mutate({...m,attemptId:'attempt'}),/variant-remediation/);
 for(const parent of [null,{...before,submitted:null},{...before,binding:{...before.binding,contentHash:'b'.repeat(64)}}]) {
  const invalid=createLocalPracticeEvidenceRepository(f.scope,{...attempts,readAttempt:id=>id==='attempt'?Promise.resolve(parent):attempts.readAttempt(id)});
  await assert.rejects(invalid.hydrate(saved),/variant-parent/);
 }
 const sourceChanged=createLocalPracticeEvidenceRepository(f.scope,{...attempts,resolveSource:async()=>({binding:{...f.binding,contentHash:'b'.repeat(64)},calculation,mapping})});await assert.rejects(sourceChanged.hydrate(saved),/source/);
});
