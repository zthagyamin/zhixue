import {after} from 'node:test';
const originalFetch=globalThis.fetch;globalThis.fetch=async()=>{throw new Error('external-fetch-denied-in-tests');};after(()=>{globalThis.fetch=originalFetch;});
import assert from 'node:assert/strict';import test from 'node:test';import {createAccountStudyQuestionAi,parseQuestionAiRequest} from '../app/account-study-question-ai.ts';import {sealStudyItem} from '../app/account-study-content.ts';import {quizBody} from './fixtures/account-study-fixtures.mjs';
const request={kind:'recall-grade',snapshotId:'snapshot-a',itemKey:'practice:one',contentHash:'a'.repeat(64),attemptId:'attempt-one',input:'My answer'};
test('question AI requires exact version/attempt binding and validates JSON output',async()=>{assert.deepEqual(parseQuestionAiRequest(request),request);const practice={...quizBody().practice,itemId:'one',questionType:'recall',answer:'Reference'};delete practice.options;const item=await sealStudyItem(quizBody({itemKey:'practice:one',practice})),calls=[];const ai=createAccountStudyQuestionAi({enabled:true,key:'account-key',model:'deepseek-model',fetcher:async(url,init)=>{calls.push({url,body:JSON.parse(init.body)});return new Response(JSON.stringify({model:'deepseek-model-20260901',choices:[{finish_reason:'stop',message:{content:JSON.stringify({text:'部分正确',verdict:'partial',rating:'hard'})}}],usage:{total_tokens:19}}),{status:200});}}),result=await ai.run(request,item,{maxOutputTokens:300});assert.equal(result.attemptId,'attempt-one');assert.equal(result.verdict,'partial');assert.equal(calls.length,1);assert.match(calls[0].url,/\/chat\/completions$/);assert.doesNotMatch(JSON.stringify(calls[0].body),/snapshot-a|practice:one/);assert.deepEqual(result.trace,{provider:'deepseek',modelId:'deepseek-model',providerModel:'deepseek-model-20260901',promptVersion:'question-ai-json-v2',ruleVersion:'recall-evaluation-v1'});});
test('disabled question AI never calls provider',async()=>{let calls=0;const ai=createAccountStudyQuestionAi({enabled:false,key:'',model:'',fetcher:async()=>{calls++;return new Response('{}');}}),item=await sealStudyItem(quizBody({itemKey:'practice:one'}));await assert.rejects(ai.run(request,item,{maxOutputTokens:300}),/disabled/);assert.equal(calls,0);});

test('versioned quiz AI receives authoritative option IDs and answer IDs',async()=>{
 const support={schemaVersion:1,type:'quiz',selection:'multiple',options:[{optionId:'a',text:'Same'},{optionId:'b',text:'Same'}],correctOptionIds:['a','b']};const body=quizBody({schemaVersion:2,learningSupport:support});delete body.practice.options;delete body.practice.answer;const item=await sealStudyItem(body);
 const ai=createAccountStudyQuestionAi({enabled:true,key:'test-key',model:'test-model',fetcher:async(url,init)=>{const source=JSON.parse(JSON.parse(init.body).messages[1].content).source;assert.deepEqual(source.answer,['a','b']);assert.deepEqual(source.options,support.options);return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({text:'Check both statements.'})}}]}));}});
 await ai.run({...request,kind:'hint'},item,{maxOutputTokens:300});
});

test('structured recall binds AI alignment to immutable criterion IDs',async()=>{
 const practice={...quizBody().practice,itemId:'one',questionType:'recall',answer:'Reference'};delete practice.options;
 const learningSupport={schemaVersion:1,type:'recall',criteria:[{id:'cause',text:'Explain cause'},{id:'effect',text:'Explain effect',mandatory:true}]};
 const item=await sealStudyItem(quizBody({schemaVersion:2,itemKey:'practice:one',practice,learningSupport}));let responseIds={matchedPointIds:['cause'],missedPointIds:['effect']};
 const ai=createAccountStudyQuestionAi({enabled:true,key:'test-key',model:'test-model',fetcher:async(url,init)=>{
  const body=JSON.parse(init.body);assert.deepEqual(JSON.parse(body.messages[1].content).criteria,learningSupport.criteria);
  return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({text:'Partial',verdict:'partial',rating:'hard',...responseIds})}}]}));
 }});
 const result=await ai.run(request,item,{maxOutputTokens:300});assert.deepEqual(result.matchedPointIds,['cause']);assert.deepEqual(result.missedPointIds,['effect']);
 for(const ids of [{matchedPointIds:['invented'],missedPointIds:['effect']},{matchedPointIds:['cause'],missedPointIds:['cause']},{matchedPointIds:['cause'],missedPointIds:[]}]){responseIds=ids;await assert.rejects(ai.run(request,item,{maxOutputTokens:300}),/alignment/);}
});
