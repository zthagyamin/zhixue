import test from 'node:test';
import assert from 'node:assert/strict';
import {decodeStudyAIStream} from '../app/ai/study-ai-service.ts';

const encode=value=>new TextEncoder().encode(value);
async function consume(chunks){
 let index=0,cancelled=false;
 const body=new ReadableStream({pull(controller){if(index<chunks.length)controller.enqueue(chunks[index++]);},cancel(){cancelled=true;}});
 const response=new Response(body,{headers:{'Content-Type':'text/event-stream'}}),events=[];
 try{for await(const event of decodeStudyAIStream(response,new AbortController().signal))events.push(event);return events;}
 finally{assert.equal(body.locked,false);assert.equal(cancelled,true);}
}
const done=encode('data: {"type":"done","model":"fixture","provider":"deepseek"}\n\n');
test('application decoder counts ignored comment frames cumulatively',async()=>{
 const frame=encode(':'+'x'.repeat(240000)+'\n\n');
 await assert.rejects(consume([...Array(36).fill(frame),done]),/ai-stream-limit/);
});
test('application decoder counts raw bytes of valid empty deltas and metadata',async()=>{
 const frame=encode('data: '+JSON.stringify({type:'delta',text:'',metadata:'x'.repeat(240000)})+'\n\n');
 await assert.rejects(consume([...Array(36).fill(frame),done]),/ai-stream-limit/);
});
test('application decoder preserves split UTF8 content and done',async()=>{
 const frame=encode('data: '+JSON.stringify({type:'delta',text:'你好，world。'})+'\n\n');
 assert.deepEqual(await consume([frame.slice(0,33),frame.slice(33,35),frame.slice(35),done]),[
  {type:'delta',text:'你好，world。'},{type:'done',model:'fixture',provider:'deepseek'}]);
});
