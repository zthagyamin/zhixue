import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createCourseTaskAi} from '../src/infrastructure/course-ai/index.ts';
import {resolveCourseTask,courseTaskHash} from '../src/domain/course-study/index.ts';
import {sealStudyItem} from '../app/account-study-content.ts';
import {quizBody} from './fixtures/account-study-fixtures.mjs';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/course-task-support-v2.json',import.meta.url)));
async function setup(){
  const support=fixture.cases[0].support;
  const body=quizBody({schemaVersion:2,learningSupport:support});
  body.practice={itemId:'question-one',abilityId:'reading-main',domain:'course',questionType:'recall',prompt:support.task.prompt,sourceLabel:'Synthetic course'};
  const task=resolveCourseTask(await sealStudyItem(body));
  return {task,request:{schemaVersion:1,attemptId:'first-attempt',taskId:task.taskId,taskHash:await courseTaskHash(task),answerRevision:1,evidenceRevision:1,requestId:'request-one'}};
}
const output=(answer)=>({schemaVersion:1,status:'correct',feedback:'转述涵盖了后进先出的含义。',matchedPointIds:['key'],missedPointIds:[],errorPointIds:[],wrongOptionIds:[],missingOptionIds:[],pointEvidence:[{pointId:'key',sourceId:'section',sourceQuote:'最后放入的元素最先取出',answerQuote:answer,reason:'转述了操作与取出顺序。'}]});
function response(body){return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(body)}}],usage:{total_tokens:123}}));}
test('task provider sends original source/scope/conditions/rubric and accepts short paraphrase evidence',async()=>{
  const {task,request}=await setup(),answer='刚放进去的那个会先拿出来',bodies=[];
  const provider=createCourseTaskAi({enabled:true,key:'synthetic-key',model:'synthetic-model',fetcher:async(_,init)=>{bodies.push(JSON.parse(init.body));return response(output(answer));}});
  const result=await provider.run(request,task,answer,{maxOutputTokens:500});
  const supplied=JSON.parse(bodies[0].messages[1].content);
  assert.deepEqual(supplied.task,task);assert.equal(supplied.learnerInput,answer);
  assert.match(bodies[0].messages[0].content,/paraphrase/i);
  assert.equal(result.diagnostic.status,'correct');assert.equal(result.diagnostic.source,'model');
  assert.equal(result.trace.requestId,'request-one');assert.equal(result.trace.promptVersion,'course-task-json-v1');
  assert.equal(result.usageTokens,123);
});
test('fabricated IDs, source quotes, answer quotes and legacy result shapes do not become grades',async()=>{
  const {task,request}=await setup(),answer='刚放进去的那个会先拿出来';
  for(const mutate of [o=>o.matchedPointIds=['invented'],o=>o.pointEvidence[0].sourceQuote='not in the source',o=>o.pointEvidence[0].answerQuote='not in the original answer',o=>o.rating='good',o=>o.source='self-assess',o=>o.pointEvidence=[]]){
    const data=output(answer);mutate(data);
    const provider=createCourseTaskAi({enabled:true,key:'synthetic-key',model:'synthetic-model',fetcher:async()=>response(data)});
    await assert.rejects(provider.run(request,task,answer,{maxOutputTokens:500}),/course-ai-output-invalid/);
  }
});
test('unavailable AI, stale task identity, and cancellation never call a model or self-assess',async()=>{
  const {task,request}=await setup();let calls=0;const fetcher=async()=>{calls++;throw Error('unexpected-call');};
  await assert.rejects(createCourseTaskAi({enabled:false,key:'synthetic-key',model:'synthetic-model',fetcher}).run(request,task,'answer',{maxOutputTokens:500}),/course-ai-disabled/);
  await assert.rejects(createCourseTaskAi({enabled:true,key:'synthetic-key',model:'synthetic-model',fetcher}).run({...request,taskHash:'b'.repeat(64)},task,'answer',{maxOutputTokens:500}),/course-ai-task-binding/);
  const abort=new AbortController();abort.abort();
  await assert.rejects(createCourseTaskAi({enabled:true,key:'synthetic-key',model:'synthetic-model',fetcher}).run(request,task,'answer',{maxOutputTokens:500},abort.signal),/course-ai-cancelled/);
  assert.equal(calls,0);
});
