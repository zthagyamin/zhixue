import test from 'node:test';
import assert from 'node:assert/strict';
import {createMathStudyEvaluator} from '../src/application/math-study/index.ts';
import {attempt,binding,support} from './fixtures/practice-evidence-fixtures.mjs';
import {createMappedMathVariant} from '../src/domain/guided-math/index.ts';

function fixture({formal=false,step='7'}={}){
    const original={...attempt('calculation'),answer:'3',submitted:{...attempt().submitted,answer:'3'},formal:formal?{status:'linked'}:null};
    const parent={...structuredClone(original),attemptId:'parent',formal:null};
    const saved=[];
    const item={binding,question:'Find elapsed time.',answer:'3',support:{...support,step:{...support.step,reference:'6'}}};
    const evidence={schemaVersion:1,attemptId:original.attemptId,binding,revision:1,updatedAt:'2026-10-08T00:00:00Z',calculation:{stepInput:{text:step,revision:1}},operations:[]};
    const engine=createMathStudyEvaluator({readAttempt:async id=>structuredClone(id===original.attemptId?original:id===parent.attemptId?parent:null),readSource:async()=>item,
        readEvidence:async()=>evidence,saveDiagnostic:async d=>saved.push(d)});
    const request={schemaVersion:1,attemptId:'attempt',answerRevision:1,sourceVersion:binding.contentHash,mode:'final'};
    return {engine,request,original,parent,item,evidence,saved};
}
test('final and optional step use saved answers and authoritative reference, with separate outcomes',async()=>{
    const f=fixture(),result=await f.engine.evaluate(f.request);
    assert.equal(result.final.status,'correct');assert.equal(result.step.status,'incorrect');
    assert.equal(f.saved[0].answerRevision,1);assert.equal(Object.hasOwn(f.saved[0],'rating'),false);
    assert.equal(f.original.evaluation.status,'pending');
    await assert.rejects(f.engine.evaluate({...f.request,answer:'6'}),/request/);
});
test('post-formal optional-step recovery produces no final result or additional grade',async()=>{
    const f=fixture({formal:true,step:'6'});
    await assert.rejects(f.engine.evaluate(f.request),/formal/);
    const result=await f.engine.evaluate({...f.request,mode:'step',stepRevision:1});
    assert.equal(result.final,undefined);assert.equal(result.step.status,'correct');
});
test('unknown source, changed revision and unsupported semantic service stay ungraded',async()=>{
    const f=fixture();await assert.rejects(f.engine.evaluate({...f.request,answerRevision:2}),/binding/);
    f.item.support.step.mode='semantic';const result=await f.engine.evaluate(f.request);
    assert.equal(result.final.status,'correct');assert.equal(result.step.status,'undetermined');
    f.item.binding={...binding,contentHash:'b'.repeat(64)};
    await assert.rejects(f.engine.evaluate(f.request),/source/);
});
test('no optional step text means no invented pending step',async()=>{
    const f=fixture({step:''});assert.equal((await f.engine.evaluate(f.request)).step,undefined);assert.equal(f.saved.length,0);
});

test('a step receipt failure leaves a reliable final available and the frozen raw step pending',async()=>{
    const f=fixture({step:'6'});
    const engine=createMathStudyEvaluator({readAttempt:async()=>f.original,readSource:async()=>f.item,readEvidence:async()=>f.evidence,
        saveDiagnostic:async()=>{throw Error('math-evidence-receipt-unknown');}});
    const result=await engine.evaluate(f.request);
    assert.equal(result.final.status,'correct');assert.equal(result.step.status,'undetermined');assert.equal(result.step.source,'none');
    assert.match(result.step.explanation,/保存/);assert.equal(f.evidence.calculation.stepInput.text,'6');assert.equal(f.evidence.calculation.diagnostic,undefined);
    await assert.rejects(engine.evaluate({...f.request,mode:'step',stepRevision:1}),/receipt-unknown/);
});

test('optional save fallback refuses source, frozen input and formal-result changes',async()=>{
 for(const change of ['source','step','formal']){
    const f=fixture({step:'6'});
    const engine=createMathStudyEvaluator({readAttempt:async()=>f.original,readSource:async()=>f.item,readEvidence:async()=>f.evidence,
      saveDiagnostic:async()=>{if(change==='source')f.item.answer='4';else if(change==='step')f.evidence.calculation.stepInput.text='7';else f.original.formal={status:'linked'};throw Error('math-evidence-receipt-unknown');}});
    await assert.rejects(engine.evaluate(f.request),/binding/);
 }
});
test('optional save receipt loss recovers an exactly persisted diagnosis by readback',async()=>{
 const f=fixture({step:'6'});
 const engine=createMathStudyEvaluator({readAttempt:async()=>f.original,readSource:async()=>f.item,readEvidence:async()=>f.evidence,
    saveDiagnostic:async d=>{f.evidence.calculation.diagnostic=d;throw Error('math-evidence-receipt-unknown');}});
 const r=await engine.evaluate(f.request);assert.equal(r.final.status,'correct');assert.equal(r.step.status,'correct');
});
test('saved variant reference is rebuilt from approved mapping instead of the original final answer',async()=>{
    const f=fixture({step:''});
    f.item.support={...f.item.support,variantMappingId:'linear-variation'};
    f.item.mapping={schemaVersion:1,mappingId:'linear-variation',parentItemKey:binding.itemKey,parentContentHash:binding.contentHash,hashKind:'content',templateVersion:1,templateId:'context-linear',sourceConditions:['恒定变化率'],parameters:{rate:3,baseline:5,target:20}};
    const mapped=await createMappedMathVariant({parent:f.item.mapping,support:f.item.support,mapping:f.item.mapping,seed:8});
    const v=mapped.variant;f.evidence.variant={schemaVersion:1,mappingId:'linear-variation',parentItemKey:binding.itemKey,parentContentHash:binding.contentHash,hashKind:'content',templateVersion:1,templateId:v.templateId,seed:v.seed,parameters:v.parameters,variantHash:v.variantHash};
    f.original.submitted.answer=JSON.stringify({answerKind:'number',answer:'5'});
    await assert.rejects(f.engine.evaluate(f.request),/variant-parent/);
    f.original.parentAttemptId='parent';f.original.checkpoint.purpose='remediation';f.original.answer=f.original.submitted.answer;
    assert.equal((await f.engine.evaluate(f.request)).final.status,'correct');
    f.evidence.variant.variantHash='b'.repeat(64);await assert.rejects(f.engine.evaluate(f.request),/variant/);
});
test('late semantic results cannot overwrite changed step input or survive cancellation',async()=>{
 const f=fixture();f.item.support.step.mode='semantic';
 const engine=createMathStudyEvaluator({readAttempt:async()=>f.original,readSource:async()=>f.item,readEvidence:async()=>f.evidence,saveDiagnostic:async d=>f.saved.push(d),semanticStep:async()=>{
  f.evidence.calculation.stepInput={text:'new step',revision:2};
  return {answerRevision:1,stepRevision:1,stepId:'source-step',sourceVersion:binding.contentHash,status:'correct',source:'model',explanation:'The saved step follows the reference.'};
 }});
 await assert.rejects(engine.evaluate({...f.request,mode:'step',stepRevision:1}),/binding/);assert.equal(f.saved.length,0);
});
test('diagnostic cache must bind exact answer, step and source revisions',async()=>{
 const f=fixture();f.evidence.calculation.diagnostic={answerRevision:9,stepRevision:1,stepId:'source-step',sourceVersion:binding.contentHash,status:'correct',source:'model',explanation:'old'};
 await assert.rejects(f.engine.evaluate(f.request),/binding/);
});
