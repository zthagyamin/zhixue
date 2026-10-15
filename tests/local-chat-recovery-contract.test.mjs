import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {studyAIErrorCode,studyAIErrorMessage,parseChatRequest} from '../src/domain/ai/index.ts';
import {decodeStudyAIStream} from '../app/ai/study-ai-service.ts';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/local-chat-recovery-v1.json',import.meta.url),'utf8'));
test('versioned local chat request matches the existing website contract',()=>{
 assert.equal(fixture.ruleVersion,'local-ai-chat-recovery-v1');
 assert.deepEqual(parseChatRequest(fixture.request),fixture.request);
});
test('local chat pending, storage, authority and budget codes retain useful UI messages',()=>{
 for(const code of fixture.errors){assert.equal(studyAIErrorCode(code),code);assert.ok(studyAIErrorMessage(code).length>0);}
});
test('replayed partial plus pending is still incomplete and never emits done',async()=>{
 const rows=[],bytes=new TextEncoder().encode('data: {"type":"delta","text":"已保存的部分回答"}\n\ndata: {"type":"error","error":"ai-request-indeterminate"}\n\n');
 const response=new Response(new ReadableStream({start(controller){controller.enqueue(bytes);controller.close();}}),{headers:{'Content-Type':'text/event-stream'}});
 await assert.rejects(async()=>{for await(const event of decodeStudyAIStream(response,new AbortController().signal))rows.push(event);},/ai-request-indeterminate/);
 assert.deepEqual(rows,[{type:'delta',text:'已保存的部分回答'}]);
 assert.equal(response.body.locked,false);
});
