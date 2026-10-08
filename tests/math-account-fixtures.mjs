import {createAccountStudyApplication} from '../src/application/account-study/index.ts';
import {applyPracticeEvidenceMutation} from '../src/domain/practice-evidence/index.ts';
import {attempt,binding,support,report} from './fixtures/practice-evidence-fixtures.mjs';
export const auth={principal:{kind:'browser',userId:'owner'}};
export function accountFixture(mode='calculation'){
 const a=attempt(mode);a.answer=a.submitted.answer=mode==='code'?'def twice(x): return x + 1':'3';
 const s={...support,step:{...support.step,mode:'semantic',reference:'Multiply rate by elapsed time'}};
 const item={kind:'practice',itemKey:binding.itemKey,contentHash:binding.contentHash,practice:{questionType:mode,prompt:mode==='code'?'Return twice the input':'Compute elapsed time',answer:'3'},learningSupport:mode==='code'?{schemaVersion:1,type:'code',functionNames:['twice'],cases:[{id:'first',functionName:'twice',args:[2],kwargs:{},expected:4}]}:s};
 const evidence={schemaVersion:1,attemptId:a.attemptId,binding:{...binding},revision:1,updatedAt:a.updatedAt,operations:[{operationId:'original',fingerprint:'a'.repeat(64),revision:1}]};
 if(mode==='code'){const run={...report(1,'student-error'),phase:'tests',assertionsExecuted:1,mapping:{prefixLineCount:0,originalLineCount:1},firstFailure:{caseId:'first',functionName:'twice',args:[2],kwargs:{},expected:4,actual:3}};evidence.execution={first:run,latest:run};}
 else evidence.calculation={stepInput:{text:'Multiply rate by elapsed time',revision:1}};
 const f={a,parent:{...structuredClone(a),attemptId:'parent'},item,evidence,s,cache:new Map(),calls:0,writes:0,receiptLoss:false,sourceAvailable:true};
 const settings={enabled:true,configured:true,provider:'deepseek',model:'mock',baseUrl:'https://api.deepseek.com',maxOutputTokens:1000,revision:1};
 f.model=async(kind,input,trace)=>kind==='math-step'?{output:{diagnostic:{answerRevision:1,stepRevision:input.stepRevision,stepId:'source-step',sourceVersion:binding.contentHash,status:'correct',source:'model',explanation:'The saved step applies the source multiplication rule.'},evidence:{sourceQuote:'Multiply rate',answerQuote:'Multiply rate',reason:'The saved step applies rate times time.'}},trace,usageTokens:10}:{output:{text:'Check what twice should return when x is 2.',sourceQuote:'Return twice',codeQuote:'x + 1',reason:'Adding one gives 3; source case expects 4.'},trace,usageTokens:10};
 const deps={now:()=>new Date('2026-10-08T01:00:00Z'),getAccessStore:async()=>({profile:async()=>({libraryId:'library'})}),getAttemptStore:async()=>({supported:async()=>true,read:async(_scope,id)=>structuredClone(id===f.a.attemptId?f.a:id===f.parent.attemptId?f.parent:null)}),
 getStudyStore:async()=>({getSnapshotItem:async()=>f.sourceAvailable?structuredClone(f.item):null,getSnapshot:async()=>({libraryId:'library',snapshotId:binding.snapshotId,items:[{itemKey:binding.itemKey,contentHash:binding.contentHash}]})}),
 getPracticeEvidenceStore:async(service)=>({supported:async()=>true,read:async()=>structuredClone(f.evidence),trustedWriter:()=>({mutate:async(scope,m)=>{
   if(f.receiptLoss){f.receiptLoss=false;throw Error('simulated-receipt-loss');}
   const authority={attempt:f.a,...(mode==='calculation'?{source:{binding,calculation:f.item.learningSupport}}:{})};
   if(m.kind==='step-diagnostic'&&m.diagnostic.source==='model')authority.modelDiagnostic=await service?.resolveModelDiagnostic?.({attempt:f.a,source:authority.source,diagnostic:m.diagnostic});
   if(m.kind==='code-hint'&&m.hint.source==='model')authority.modelHint=await service?.resolveModelHint?.({attempt:f.a,hint:m.hint});
   const receipt=await applyPracticeEvidenceMutation(f.evidence,m,authority);if(receipt.status==='accepted'){f.evidence=receipt.record;f.writes++;}return {...receipt,durable:receipt.status!=='conflict'};
 }})}),getAiStore:async()=>({getSettings:async()=>settings,begin:async(scope,r)=>{const old=f.cache.get(r.requestId);if(old&&old.hash!==r.inputHash)throw Error('ai-request-conflict');return old?{status:old.status,result:old.result,settings}:{status:'accepted',settings};},complete:async(scope,id,hash,result)=>f.cache.set(id,{hash,result,status:'completed'}),fail:async(scope,id,hash)=>f.cache.set(id,{hash,status:'failed'})}),
 getPracticeAi:async()=>({run:async(...args)=>{f.calls++;return f.model(...args);}})};
 f.deps=deps;f.app=createAccountStudyApplication(deps);f.send=body=>f.app.post(structuredClone(body),auth,new AbortController().signal);
 f.math={action:'math-evaluate',requestId:'req',request:{schemaVersion:1,attemptId:'attempt',answerRevision:1,sourceVersion:binding.contentHash,mode:'step',stepRevision:1}};
 f.hint={action:'code-hint',requestId:'req',request:{schemaVersion:1,attemptId:'attempt',answerRevision:1,sourceVersion:binding.contentHash,runId:1,caseId:'first'}};
 return f;
}
