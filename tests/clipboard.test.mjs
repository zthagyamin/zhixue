import test from 'node:test';
import assert from 'node:assert/strict';
import {copyTextSafely} from '../app/clipboard.ts';
test('copy writes exactly the requested text and preserves the clipboard receiver',async()=>{
 const clipboard={value:null,async writeText(text){this.value=text;}};
 assert.equal(await copyTextSafely('中文\n```code```',()=>clipboard),true);assert.equal(clipboard.value,'中文\n```code```');
});
test('copy without a Clipboard API reports failure rather than throwing',async()=>{
 for(const clipboard of [undefined,null,{}, {writeText:null}])assert.equal(await copyTextSafely('text',()=>clipboard),false);
});
test('copy catches a denied property getter',async()=>{
 assert.equal(await copyTextSafely('text',()=>{throw new Error('Access denied');}),false);
});
test('copy catches synchronous method failure',async()=>{
 assert.equal(await copyTextSafely('text',()=>({writeText(){throw new Error('blocked');}})),false);
});
test('copy catches rejected permission requests',async()=>{
 assert.equal(await copyTextSafely('text',()=>({writeText:async()=>{throw new DOMException('Not allowed','NotAllowedError');}})),false);
});
test('copy only reports success after the write promise resolves',async()=>{
 let complete,settled=false;const write=new Promise(resolve=>{complete=resolve;});
 const pending=copyTextSafely('text',()=>({writeText:()=>write})).then(result=>{settled=true;return result;});
 await Promise.resolve();assert.equal(settled,false);complete();assert.equal(await pending,true);
});
