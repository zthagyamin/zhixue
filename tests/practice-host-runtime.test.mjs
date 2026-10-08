import test from 'node:test';
import assert from 'node:assert/strict';
import {indexedDB} from 'fake-indexeddb';
import {createNonWordRuntime,restoredFields} from '../src/infrastructure/nonword-study/index.ts';
import {attachPracticeDriver} from '../src/infrastructure/practice-evidence/host-runtime.ts';
import {applyPracticeEvidenceMutation} from '../src/domain/practice-evidence/index.ts';

globalThis.indexedDB=indexedDB;
const scope={workspaceId:'practice-host',ownerId:'practice-host-owner',libraryId:'practice-host-library',snapshotId:'snapshot',itemKey:'code',contentHash:'a'.repeat(64),groupId:'group',roundId:'round',cloud:false};
const attach=async runtime=>attachPracticeDriver({runtime,restore:()=>restoredFields(runtime.session.snapshot(),'code')},runtime);
const report=runtime=>({schemaVersion:1,runId:1,status:'failed',phase:'program',outcome:'unknown',assertionsPassed:0,assertionsExecuted:0,
    mapping:{prefixLineCount:0,originalLineCount:1},identity:{attemptId:runtime.session.snapshot().attemptId,revision:runtime.session.snapshot().submitted.answerRevision,sourceVersion:scope.contentHash,testVersion:scope.contentHash}});
test('the actual driver adapter restores separate execution output without adding V1 checkpoint fields',async()=>{
    const first=await attach(await createNonWordRuntime(scope,'code'));
    await first.runtime.session.submit('original');
    await first.runtime.practice.recordCodeReport(report(first.runtime),'full original traceback');
    const saved=first.runtime.session.snapshot();assert.equal(saved.submitted.answer,'original');
    assert.equal(Object.hasOwn(saved.checkpoint.pluginFields??{},'executionReport'),false);assert.equal(saved.formal,null);
    const restored=await attach(await createNonWordRuntime(scope,'code'));
    assert.equal((await restored.runtime.practice.codeFeedback()).output,'full original traceback');
    assert.equal(restored.runtime.session.snapshot().evaluation.status,'pending');
});
test('prepared child feedback restores through its explicit identity and preserves parent first report',async()=>{
    const scoped={...scope,roundId:'child-round'},parent=await attach(await createNonWordRuntime(scoped,'code'));
    await parent.runtime.session.submit('original');await parent.runtime.practice.recordCodeReport(report(parent.runtime),'parent output');
    const child=await attach(await createNonWordRuntime(scoped,'code',{purpose:'remediation',parentAttemptId:parent.runtime.session.snapshot().attemptId,instanceId:'child-instance'}));
    await child.runtime.session.submit('child');await child.runtime.practice.recordCodeReport(report(child.runtime),'child output');
    await parent.runtime.practice.recordPrepared({instanceId:'child-instance',attemptId:child.runtime.session.snapshot().attemptId});
    const restored=await attach(await createNonWordRuntime(scoped,'code'));
    const feedback=await restored.runtime.practice.codeFeedback();
    assert.equal(feedback.first.identity.attemptId,parent.runtime.session.snapshot().attemptId);
    assert.equal(feedback.latest.identity.attemptId,child.runtime.session.snapshot().attemptId);
    assert.equal(feedback.output,'child output');
    assert.equal(restored.runtime.session.snapshot().submitted.answer,'original');
    await restored.runtime.session.save('original',{code:'newer independent edit'});
    assert.equal(restored.restore().code,'newer independent edit');
    const reopened=await attach(await createNonWordRuntime(scoped,'code'));
    assert.equal(reopened.restore().code,'newer independent edit');
});

test('a prepared child without a saved run never substitutes the parent editor draft',async()=>{
    const scoped={...scope,roundId:'child-not-run-round'},parent=await attach(await createNonWordRuntime(scoped,'code'));
    await parent.runtime.session.submit('original');
    const child=await attach(await createNonWordRuntime(scoped,'code',{purpose:'remediation',parentAttemptId:parent.runtime.session.snapshot().attemptId,instanceId:'not-run-instance'}));
    await child.runtime.session.submit('not yet run');
    await parent.runtime.practice.recordPrepared({instanceId:'not-run-instance',attemptId:child.runtime.session.snapshot().attemptId});
    assert.equal((await attach(await createNonWordRuntime(scoped,'code'))).restore().code,'original');
});

test('account evidence synchronizes only after original answers and restores exact remote feedback',async()=>{
    const base=await createNonWordRuntime({...scope,ownerId:'cloud-order-owner',roundId:'cloud-order'},'code');
    await base.session.submit('saved before run');
    const events=[];let remote=null;
    const cloud={async mutate(mutation){
        events.push('evidence');assert.equal(events[0],'original');
        const receipt=await applyPracticeEvidenceMutation(remote,mutation,{attempt:await base.repository.read(mutation.attemptId)});
        remote=receipt.record;return {...receipt,durable:true};
    },async read(){return remote;}};
    const runtime={...base,scope:{...base.scope,cloud:true},async synchronize(){events.push('original');}};
    const driver=await attachPracticeDriver({runtime},runtime,{cloud});
    await driver.runtime.practice.recordCodeReport(report(base),'saved cloud traceback');
    assert.deepEqual(events,['original','evidence']);
    assert.equal(remote.execution.firstOutput,'saved cloud traceback');
    assert.match(await driver.runtime.practice.status(),/已同步/);
    await driver.runtime.synchronize();assert.deepEqual(events,['original','evidence','original']);
});

test('unsupported account capability retains durable local evidence and an honest status',async()=>{
    const base=await createNonWordRuntime({...scope,ownerId:'cloud-unsupported-owner',roundId:'cloud-unsupported'},'code');await base.session.submit('retained');
    const cloud={async mutate(){return {status:'unsupported'};},async read(){return null;}};
    const runtime={...base,scope:{...base.scope,cloud:true},async synchronize(){}};
    const driver=await attachPracticeDriver({runtime},runtime,{cloud});
    await assert.rejects(()=>driver.runtime.practice.recordCodeReport(report(base),'retained output'),/尚未取得同步回执/);await driver.runtime.synchronize();
    assert.equal((await driver.runtime.practice.codeFeedback()).output,'retained output');
    assert.match(await driver.runtime.practice.status(),/不支持/);
});

test('explicit local model hint is durably restored and never changes original result or first report',async()=>{
    const runtime=await createNonWordRuntime({...scope,ownerId:'model-hint-owner'},'code');await runtime.session.submit('original');
    let calls=0;
    const options={async requestHint(input){calls++;assert.equal(input.answer,'original');return '检查循环的结束条件。';}};
    const driver=await attachPracticeDriver({runtime},runtime,options),run=report(runtime);
    await driver.runtime.practice.recordCodeReport(run,'traceback');
    assert.equal(calls,0);assert.equal(await driver.runtime.practice.requestCodeHint(run),'检查循环的结束条件。');
    const restored=await attachPracticeDriver({runtime},runtime,options);
    assert.equal((await restored.runtime.practice.codeFeedback()).hint.source,'model');
    assert.equal(await restored.runtime.practice.requestCodeHint(run),'检查循环的结束条件。');assert.equal(calls,1);
    assert.deepEqual((await restored.runtime.practice.codeFeedback()).first,run);assert.equal(runtime.session.snapshot().evaluation.status,'pending');assert.equal(runtime.session.snapshot().formal,null);
});

test('a reliable final remains available when optional step diagnostic cannot be saved',async()=>{
    const runtime=await createNonWordRuntime({...scope,ownerId:'math-independent-owner'},'calculation');
    const support={schemaVersion:2,type:'calculation',mode:'numeric',variables:[],domain:'real',step:{stepId:'declared-step',prompt:'关键一步',reference:'2',mode:'numeric'}};
    const driver=await attachPracticeDriver({runtime},runtime,{resolveSource:async attempt=>({binding:attempt.binding,calculation:support}),
        calculation:{support,persistLocalDiagnostic:true,async evaluate(request){return {schemaVersion:1,attemptId:request.attemptId,answerRevision:request.answerRevision,sourceVersion:request.sourceVersion,
            ...(request.mode==='final'?{final:{status:'correct',source:'deterministic',explanation:'最终结果一致。'}}:{}),
            step:{answerRevision:request.answerRevision,sourceVersion:request.sourceVersion,stepRevision:1,stepId:'wrong-step',status:'correct',source:'deterministic',explanation:'Unbound step result'}};}}});
    await driver.runtime.practice.saveStep('2');await runtime.session.submit('4');
    const result=await driver.runtime.practice.calculation.evaluate('final');
    assert.equal(result.final.status,'correct');assert.equal(result.step.status,'undetermined');
    assert.match(result.step.explanation,/尚未保存/);assert.equal(driver.runtime.practice.snapshot().calculation.stepInput.text,'2');
    assert.equal(driver.runtime.practice.snapshot().calculation.diagnostic,undefined);
    await assert.rejects(()=>driver.runtime.practice.calculation.evaluate('step'),/practice-evidence/);
    assert.equal(runtime.session.snapshot().formal,null);assert.equal(runtime.session.snapshot().evaluation.status,'pending');
});

test('pause flush durably saves an unsubmitted step, including a later explicit clearing',async()=>{
    const runtime=await createNonWordRuntime({...scope,ownerId:'math-step-draft-owner'},'calculation');
    const support={schemaVersion:2,type:'calculation',mode:'numeric',variables:[],domain:'real',step:{stepId:'draft-step',prompt:'关键一步',reference:'2',mode:'numeric'}};
    const options={resolveSource:async attempt=>({binding:attempt.binding,calculation:support})};
    const driver=await attachPracticeDriver({runtime},runtime,options);
    driver.runtime.practice.stageStep('unsubmitted raw step');await driver.runtime.practice.flush();
    const restored=await attachPracticeDriver({runtime},runtime,options);
    assert.equal(restored.runtime.practice.snapshot().calculation.stepInput.text,'unsubmitted raw step');assert.equal(runtime.session.snapshot().submitted,null);
    driver.runtime.practice.stageStep('');await driver.runtime.practice.flush();
    const cleared=await attachPracticeDriver({runtime},runtime,options);assert.equal(cleared.runtime.practice.snapshot().calculation.stepInput.text,'');
    await runtime.session.submit('3');assert.throws(()=>driver.runtime.practice.stageStep('late changed step'),/不能改写/);
});

test('the account step receipt is durable before its final answer can be frozen',async()=>{
    const base=await createNonWordRuntime({...scope,ownerId:'step-before-submit-owner'},'calculation');
    const support={schemaVersion:2,type:'calculation',mode:'numeric',variables:[],domain:'real',step:{stepId:'source-step',prompt:'关键一步',reference:'2',mode:'numeric'}};
    let remote=null;const events=[];
    const cloud={async read(){return remote;},async mutate(mutation){
        const original=await base.repository.read(mutation.attemptId);assert.equal(original.submitted,null,'first step must reach its service before submit');
        events.push('step');const receipt=await applyPracticeEvidenceMutation(remote,mutation,{attempt:original,source:{binding:original.binding,calculation:support}});
        remote=receipt.record;return {...receipt,durable:true};
    }};
    const runtime={...base,scope:{...base.scope,cloud:true},async synchronize(){events.push('original');}};
    const driver=await attachPracticeDriver({runtime},runtime,{cloud,resolveSource:async original=>({binding:original.binding,calculation:support})});
    driver.runtime.practice.stageStep('99');await driver.runtime.practice.saveStep('99');
    assert.equal(remote?.calculation.stepInput.text,'99');assert.deepEqual(events,['original','step']);
    await base.session.submit('3');assert.equal(base.session.snapshot().submitted.answer,'3');
});

test('actual saved evaluation is projected independently from immutable first run evidence',async()=>{
    const runtime=await createNonWordRuntime({...scope,ownerId:'code-authoritative-restore-owner'},'code');await runtime.session.submit('original');
    const driver=await attachPracticeDriver({runtime},runtime),first=report(runtime);
    await driver.runtime.practice.recordCodeReport(first,'unknown first output');
    await driver.runtime.practice.recordCodeReport({...first,runId:2,status:'passed',phase:'tests',outcome:'success',assertionsPassed:1,assertionsExecuted:1},'public checks passed');
    assert.equal((await driver.runtime.practice.codeFeedback()).firstState.status,'pending');
    await runtime.session.assess({status:'correct',source:'deterministic',rating:'good',explanation:'Public checks passed.'});
    const restored=await attachPracticeDriver({runtime},runtime),saved=await restored.runtime.practice.codeFeedback();
    assert.equal(saved.first.outcome,'unknown');assert.equal(saved.latest.outcome,'success');assert.equal(saved.firstState.status,'correct');
});
