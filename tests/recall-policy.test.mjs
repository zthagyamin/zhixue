import test from 'node:test';import assert from 'node:assert/strict';
import {parseRecallPolicy} from '../app/recall-policy.ts';
import {sealAssistanceSummary,parseAssistanceSummary} from '../app/assistance-summary.ts';
const policy={policyVersion:'recall-hints-v1',attemptId:'recall-attempt-one',maxPreHintLevel:2,requestedRating:'good',appliedRating:'hard'};
test('a claimed rating must agree with the recorded hint policy',()=>{assert.deepEqual(parseRecallPolicy(policy),policy);assert.throws(()=>parseRecallPolicy({...policy,appliedRating:'good'}));});
test('version two auxiliary records keep original and applied ratings with immutable hashes',async()=>{
 const raw={schemaVersion:2,attemptEventId:'event-one',attemptCoreHash:'a'.repeat(64),practiceMode:'recall',observationScope:'current-page-attempt',preSubmitAssistance:[],postSubmitFeedback:[],recallPolicy:policy};
 const summary=await sealAssistanceSummary(raw);assert.deepEqual((await parseAssistanceSummary(summary)).recallPolicy,policy);
 await assert.rejects(sealAssistanceSummary({...raw,schemaVersion:1}));await assert.rejects(sealAssistanceSummary({...raw,practiceMode:'quiz'}));
});

test('version two summary matches the shared cross-runtime golden',async()=>{
 const {readFile}=await import('node:fs/promises'),golden=JSON.parse(await readFile(new URL('./fixtures/assistance-summary-v2.json',import.meta.url)));
 const body=Object.fromEntries(Object.entries(golden).filter(([key])=>!['summaryId','summaryHash'].includes(key)));
 assert.deepEqual(await sealAssistanceSummary(body),golden);
});
