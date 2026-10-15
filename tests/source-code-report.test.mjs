import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import * as contracts from '../src/domain/source-admission/index.ts';
import {parseCodeRunReport} from '../src/domain/code-execution/index.ts';
import {createSourceAdmissionClient,sourceAdmissionFingerprint as hash} from '../src/infrastructure/source-admission/index.ts';
import {createSourceLearningSession} from '../src/application/source-admission/index.ts';
import {sourceCodeReports} from '../src/infrastructure/source-admission/code-reports.ts';

const fixtures=JSON.parse(readFileSync(new URL('./fixtures/code-run-report-contract-v1.json',import.meta.url),'utf8'));
for(const row of fixtures.cases)test('shared actual code report contract: '+row.name,()=>{
 if(row.normalized)assert.deepEqual(parseCodeRunReport(row.input),row.normalized);
 else assert.throws(()=>parseCodeRunReport(row.input));
});
const binding={ownerId:'paired-owner',libraryId:'code-library',itemKey:'legacy-code',contentHash:'a'.repeat(64),captureId:'source-capture:'+'b'.repeat(64)};
const submission={attemptId:'code-original',binding,answerRevision:0,submittedAt:'2026-10-10T10:00:00.000Z',answer:'def add(a, b):\n    return a + b',purpose:'first'};
const request={schemaVersion:1,attemptId:submission.attemptId,binding,answerRevision:0,submittedAt:submission.submittedAt,report:fixtures.cases[0].input};
async function receipt(value=request){const evidenceHash=await hash(value);return {schemaVersion:1,durable:true,reportId:'code-report:'+evidenceHash,evidence:value,evidenceHash,provenance:'client-public-tests'};}
function client(fetcher,extra={}){return createSourceAdmissionClient({baseUrl:'http://127.0.0.1:8765',sessionToken:'A'.repeat(43),
 libraryId:binding.libraryId,remoteOwnerId:binding.ownerId,capabilities:['nonword-source-v1'],fetcher,...extra});}

test('code declaration preserves its original wire shape and accepts a durable scoped receipt',async()=>{
 const response=await receipt(),calls=[];
 const transport=client(async(_url,init)=>{calls.push(JSON.parse(init.body));return Response.json(response);});
 const saved=await transport.codeReport(request,submission);
 assert.deepEqual(saved,response);assert.deepEqual(calls,[{schemaVersion:1,action:'code-report',request}]);
 assert.deepEqual(contracts.parseSourceCodeReport(request),request);
});
test('wrong original revision, source, owner and timestamp cannot disclose a report',async()=>{
 let calls=0;const transport=client(async()=>{calls++;return Response.json(await receipt());});
 for(const change of [r=>{r.report.identity.revision++;},r=>{r.report.identity.testVersion='c'.repeat(64);},
  r=>{r.binding.ownerId='another-owner';},r=>{r.answerRevision++;},r=>{r.submittedAt='2026-10-10T11:00:00.000Z';}]){
  const wrong=structuredClone(request);change(wrong);await assert.rejects(transport.codeReport(wrong,submission));
 }
 assert.equal(calls,0);
});
test('rehashed altered evidence and invented server provenance are refused',async()=>{
 const changed=structuredClone(request);changed.report.runId++;
 for(const response of [await receipt(changed),{...await receipt(),provenance:'server-execution'},
  {...await receipt(),reportId:'code-report:'+'c'.repeat(64)}]){
  await assert.rejects(client(async()=>Response.json(response)).codeReport(request,submission));
 }
});
test('unsupported and retired source clients never disclose code declarations',async()=>{
 const fetcher=async()=>assert.fail('Inactive transport must not receive code.');
 await assert.rejects(client(fetcher,{capabilities:[]}).codeReport(request,submission),/unsupported/);
 const transport=client(fetcher);transport.retire();await assert.rejects(transport.codeReport(request,submission),/stale/);
});

const python=JSON.parse(readFileSync(new URL('./fixtures/source-code-report-python-v1.json',import.meta.url),'utf8'));
test('actual Python read and report receipts pass paired SDK validation without becoming formal evidence',async()=>{
 const f=python,calls=[];
 const transport=client(async(_url,init)=>{const body=JSON.parse(init.body);calls.push(body);
  return Response.json({'read':f.readReceipt,'code-report':f.codeReportReceipt}[body.action]);
 },{libraryId:f.submission.binding.libraryId,remoteOwnerId:f.submission.binding.ownerId});
 const {binding:original,...core}=f.submission;
 const saved=await transport.read(core.attemptId,{...core,itemKey:original.itemKey,contentHash:original.contentHash,libraryId:original.libraryId});
 assert.deepEqual(saved.codeReports,[f.codeReportReceipt]);
 assert.deepEqual(await transport.codeReport(f.codeReportRequest,f.submission),f.codeReportReceipt);
 assert.equal(calls.some(call=>['evaluate','claim'].includes(call.action)),false);
});
function codeAttempt(){const s=python.submission;return {attemptId:s.attemptId,binding:{ownerId:'local-owner',libraryId:s.binding.libraryId,
 itemKey:s.binding.itemKey,contentHash:s.binding.contentHash,snapshotId:'local',groupId:'group',roundId:'round'},
 parentAttemptId:null,submitted:{answer:s.answer,answerRevision:s.answerRevision,submittedAt:s.submittedAt,
 assistance:s.assistance??'unknown',...(s.maxPreHintLevel===undefined?{}:{maxPreHintLevel:s.maxPreHintLevel}),
 ...(s.answerRevealed===undefined?{}:{answerRevealed:s.answerRevealed})},checkpoint:{purpose:s.purpose??'unknown'}};}
test('source use case publishes reliably saved original code reports before pending continuation without evaluating unknown source',async()=>{
 const f=python,calls=[];
 const transport=client(async(_url,init)=>{const body=JSON.parse(init.body);calls.push(body);
  return Response.json({capture:f.capture,read:f.readReceipt,'code-report':f.codeReportReceipt}[body.action]);
 },{libraryId:f.submission.binding.libraryId,remoteOwnerId:f.submission.binding.ownerId});
 const session=createSourceLearningSession({query:f.query,libraryId:f.submission.binding.libraryId,transport,
  readCodeReports:async()=>[structuredClone(f.codeReportRequest.report)],fingerprint:hash,newId:()=>assert.fail('Unknown source cannot evaluate.')});
 const result=await session.assess(codeAttempt(),{status:'correct',source:'deterministic',explanation:'Public checks only.'});
 assert.equal(result.status,'pending');assert.deepEqual(calls.map(row=>row.action),['capture','read','code-report']);
 assert.deepEqual(calls[2].request,f.codeReportRequest);
});
test('source use case cannot evaluate without saved code reports, and refuses a child report on the original',async()=>{
 const f=python,calls=[],transport={supported:()=>true,capture:async()=>f.capture,read:async()=>f.readReceipt,
  evaluate:async()=>assert.fail('Missing or unbound run must remain pending.'),codeReport:async raw=>{calls.push(raw);return f.codeReportReceipt;}};
 const empty=createSourceLearningSession({query:f.query,libraryId:f.submission.binding.libraryId,transport,
  readCodeReports:async()=>[],fingerprint:hash,newId:()=>assert.fail()});
 assert.equal((await empty.assess(codeAttempt())).status,'pending');assert.equal(calls.length,0);
 const child=structuredClone(f.codeReportRequest.report);child.identity.attemptId='remediation-child';
 const wrong=createSourceLearningSession({query:f.query,libraryId:f.submission.binding.libraryId,transport,
  readCodeReports:async()=>[child],fingerprint:hash,newId:()=>assert.fail()});
 await assert.rejects(wrong.assess(codeAttempt()),/identity|binding/);assert.equal(calls.length,0);
});
test('read receipts cannot mix a different attempt, forged report hash or duplicate report into saved evidence',async()=>{
 const f=python,{binding:original,...core}=f.submission;
 for(const change of [r=>{r.codeReports[0].evidenceHash='c'.repeat(64);r.codeReports[0].reportId='code-report:'+'c'.repeat(64);},
  r=>{r.codeReports.push(structuredClone(r.codeReports[0]));},r=>{r.codeReports[0].evidence.attemptId='other';}]){
  const response=structuredClone(f.readReceipt);change(response);
  await assert.rejects(client(async()=>Response.json(response),{libraryId:original.libraryId,remoteOwnerId:original.ownerId})
   .read(core.attemptId,{...core,itemKey:original.itemKey,contentHash:original.contentHash,libraryId:original.libraryId}));
 }
});
test('practice adapter retains first and recovery reports while excluding the child navigation pointer',async()=>{
 const original=codeAttempt(),first=structuredClone(python.codeReportRequest.report),latest=structuredClone(first);latest.runId++;
 let saved={attemptId:original.attemptId,binding:original.binding,execution:{first,latest,prepared:{attemptId:'child',instanceId:'child-run'}}};
 const read=sourceCodeReports({refresh:async()=>{},snapshot:()=>saved});
 assert.deepEqual(await read(original),[first,latest]);saved.execution.latest=structuredClone(first);
 assert.deepEqual(await read(original),[first]);saved.binding={...original.binding,ownerId:'other'};
 await assert.rejects(read(original),/binding/);
});
test('valid large finite numeric run evidence is preserved verbatim by source wrapper and hash',async()=>{
 const value=structuredClone(request);value.report={...value.report,status:'failed',phase:'tests',outcome:'student-error',
  assertionsPassed:0,assertionsExecuted:1,firstFailure:{caseId:'large',functionName:'calculate',args:[1e20],kwargs:{},expected:1e21,actual:1e100}};
 assert.deepEqual(parseCodeRunReport(value.report).firstFailure.actual,1e100);
 assert.deepEqual(contracts.parseSourceCodeReport(value),value);
 const saved=await receipt(value);assert.deepEqual(await client(async()=>Response.json(saved)).codeReport(value,submission),saved);
});
test('saving pending code on a confirmed source does not invoke evaluation or formal claim',async()=>{
 const f=python,calls=[],capture={...structuredClone(f.capture),status:'confirmed',sourceBinding:f.capture.binding,item:f.query.presentation,eventKind:'python'};
 delete capture.reason;
 const transport={supported:()=>true,capture:async()=>capture,read:async()=>({...f.readReceipt,sourceBinding:capture.sourceBinding}),
  codeReport:async raw=>{calls.push(raw);return f.codeReportReceipt;},
  evaluate:async()=>assert.fail('Unknown execution upload must not invoke grading.'),claim:async()=>assert.fail()};
 const source=createSourceLearningSession({query:f.query,libraryId:f.submission.binding.libraryId,transport,
  readCodeReports:async()=>[f.codeReportRequest.report],fingerprint:hash,newId:()=>assert.fail()});
 await source.savePending(codeAttempt());assert.deepEqual(calls,[f.codeReportRequest]);
});
test('large finite JSON wire numbers have the actual Python source fingerprint',async()=>{
 const values=[1e20,1e21,1e100,-1e100,Number.MAX_VALUE,Number.MIN_VALUE,9007199254740992];
 const python=spawnSync(process.env.PYTHON||'python',['-X','utf8','-c',
  "import sys,json; sys.path.insert(0,'companion'); from infrastructure.source_protocol_hash import fingerprint; print(fingerprint(json.loads(sys.stdin.read())))"],
  {input:JSON.stringify(values),encoding:'utf8',windowsHide:true,timeout:15000});
 assert.equal(python.error,undefined);assert.equal(python.status,0,python.stderr);
 assert.equal(await hash(values),python.stdout.trim());
});
