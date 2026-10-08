import test from 'node:test';import assert from 'node:assert/strict';
import {studyAIPageContext} from '../app/ai/study-ai-page-context.ts';
import {normalizeStudyAIContext,buildStudyAIRequest} from '../app/ai/study-ai-context.ts';
import {parseChatRequest} from '../app/ai/study-ai-chat.ts';
import {legacyStudyAIConversations} from '../app/ai/study-ai-conversations.ts';
import {studyAIHistoryKey} from '../app/ai/study-ai-service.ts';
const base={page:'today',day:'2026-09-08',subjects:[{subjectId:'p',name:'Python',itemCount:12}],planState:'approved',historyReady:true,practiceCount:2};
test('page context follows actual task and progress data without importing arbitrary source or settings fields',()=>{
 const context=studyAIPageContext({...base,tasks:[{subjectId:'p',title:'Review sorting',category:'review',quantity:1,sourceNote:'private-path'}],providerKey:'DO-NOT-READ',account:{email:'private@example.test'}});assert.match(context.pageText,/Python|Review sorting/);assert.doesNotMatch(JSON.stringify(context),/private|DO-NOT-READ|sourceNote/);
 const progress=studyAIPageContext({...base,page:'progress',historyReady:false,practiceCount:99});assert.match(progress.pageText,/尚未核对完整/);assert.doesNotMatch(progress.pageText,/99 次/);
});
test('large current pages and long conversations become valid bounded requests while keeping the latest question',()=>{
 const context={id:'question',title:'题目',pageText:'页面'.repeat(8000),code:'"'.repeat(15000),learnerAnswer:'answer'.repeat(1200),errors:['error'.repeat(1500)]};
 const messages=Array.from({length:30},(_,i)=>({id:String(i),role:i%2?'assistant':'user',content:'old'.repeat(4000)}));messages.push({id:'last',role:'user',content:'我的最新问题'});
 const request=buildStudyAIRequest({provider:'deepseek',model:'deepseek-v4-flash',revision:1},context,messages,'bounded');assert.ok(JSON.stringify(request).length<=48000);assert.equal(request.messages.at(-1).content,'我的最新问题');assert.equal(request.context.truncated,true);assert.doesNotThrow(()=>parseChatRequest(request));assert.equal(normalizeStudyAIContext({id:'q',title:'x',secret:'hidden'}).secret,undefined);
});
test('old conversations remain selectable but other accounts and providers are never loaded',()=>{
 const scope={mode:'account',ownerId:'one',libraryId:'lib'},own=studyAIHistoryKey(scope,'deepseek','page:today:current'),foreign=studyAIHistoryKey({...scope,ownerId:'two'},'deepseek','page:today:current'),other=studyAIHistoryKey(scope,'chatgpt','page:today:current'),keys=[own,foreign,other];
 const storage={length:keys.length,key:i=>keys[i],getItem:key=>{assert.equal(key,own,'foreign history must not even be read');return JSON.stringify([{id:'one',role:'user',content:'Old question'}]);}};
 const rows=legacyStudyAIConversations(storage,scope,'deepseek');assert.equal(rows.length,1);assert.equal(rows[0].key,own);
});
