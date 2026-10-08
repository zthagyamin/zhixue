import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {studyHash} from '../app/account-study-content.ts';
const vectors=JSON.parse(await readFile(new URL('./fixtures/account-study-v1.json',import.meta.url)));
let api;try{api=await import('../app/assistance-summary.ts');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
const ready=()=>assert.equal(typeof api?.sealAssistanceSummary,'function','Behavior-only summary protocol must exist');
function body(){const parent=vectors.records[0];return{schemaVersion:1,attemptEventId:parent.event.eventId,attemptCoreHash:parent.event.coreHash,practiceMode:parent.practiceMode,
  observationScope:'current-page-attempt',preSubmitAssistance:[{action:'meaning-check',count:1}],postSubmitFeedback:[]};}
test('TypeScript matches the shared cross-runtime golden summary',async()=>{
  ready();const golden=JSON.parse(await readFile(new URL('./fixtures/assistance-summary-v1.json',import.meta.url)));
  assert.deepEqual(await api.sealAssistanceSummary(body()),golden);assert.deepEqual(await api.parseAssistanceSummary(golden),golden);
});
test('summary is immutable, bounded and deterministically associated with one attempt',async()=>{
  ready();const raw=body(),summary=await api.sealAssistanceSummary(raw);raw.preSubmitAssistance[0].count=8;
  assert.equal(summary.preSubmitAssistance[0].count,1);assert.deepEqual(await api.parseAssistanceSummary(summary),summary);
  assert.equal((await api.sealAssistanceSummary(body())).summaryId,summary.summaryId);
  await assert.rejects(api.parseAssistanceSummary({...summary,preSubmitAssistance:[]}),/integrity/);
  const changed={...summary,summaryId:'other'};changed.summaryHash=await studyHash(Object.fromEntries(Object.entries(changed).filter(([key])=>key!=='summaryHash')));
  await assert.rejects(api.parseAssistanceSummary(changed),/identifier/);
});
test('summary binding validates the original core and known practice mode, not just an item key',async()=>{
  ready();const summary=await api.sealAssistanceSummary(body()),parent=vectors.records[0];
  await api.validateAssistanceParent(summary,parent.event,parent.practiceMode);
  await assert.rejects(api.validateAssistanceParent(summary,vectors.records[1].event,parent.practiceMode),/parent/);
  await assert.rejects(api.validateAssistanceParent(summary,parent.event,'spelling'),/mode/);
  await assert.rejects(api.validateAssistanceParent(summary,{...parent.event,attempt:{...parent.event.attempt,stageAfter:3}},parent.practiceMode),/hash/);
});
test('action order canonicalizes and later feedback is not promoted to pre-submit help',async()=>{
  ready();const a=body();a.preSubmitAssistance=[{action:'ai-hint',count:1},{action:'meaning-check',count:1}];
  const b=structuredClone(a);b.preSubmitAssistance.reverse();assert.deepEqual(await api.sealAssistanceSummary(a),await api.sealAssistanceSummary(b));
  a.preSubmitAssistance=[{action:'answer-feedback',count:1}];await assert.rejects(api.sealAssistanceSummary(a),/action/);
  a.preSubmitAssistance=[];a.postSubmitFeedback=[{action:'answer-feedback',count:1}];await api.sealAssistanceSummary(a);
});
for(const key of ['prompt','answer','chat','sourceNote','localPath','stage','occurredAt'])test(`summary rejects unsolicited ${key}`,async()=>{
  ready();await assert.rejects(api.sealAssistanceSummary({...body(),[key]:'not-stored'}),/field/);
});
for(const count of [0,-1,1.5,true,'1',10001,Number.MAX_SAFE_INTEGER+1])test(`summary rejects invalid count ${String(count)}`,async()=>{
  ready();const raw=body();raw.preSubmitAssistance[0].count=count;await assert.rejects(api.sealAssistanceSummary(raw),/count/);
});
test('unsupported versions, modes, duplicated actions and unbounded payloads are rejected',async()=>{
  ready();await assert.rejects(api.sealAssistanceSummary({...body(),schemaVersion:2}),/version/);
  await assert.rejects(api.sealAssistanceSummary({...body(),practiceMode:['quiz']}),/mode/);
  await assert.rejects(api.sealAssistanceSummary({...body(),observationScope:'whole-history'}),/scope/);
  const raw=body();raw.preSubmitAssistance.push({...raw.preSubmitAssistance[0]});await assert.rejects(api.sealAssistanceSummary(raw),/duplicate/);
  raw.preSubmitAssistance=Array(1000).fill({action:'meaning-check',count:1});await assert.rejects(api.sealAssistanceSummary(raw),/large/);
});
test('empty observation is explicitly page-limited and old absence stays unknown',async()=>{
  ready();const raw=body();raw.preSubmitAssistance=[];const summary=await api.sealAssistanceSummary(raw);
  assert.equal(api.assistanceObservationLabel(null),'辅助情况未知');assert.equal(api.assistanceObservationLabel(summary),'本次页面未记录作答前辅助');
  assert.equal(api.assistanceObservationLabel(await api.sealAssistanceSummary(body())),'本次记录了作答前辅助');
});
