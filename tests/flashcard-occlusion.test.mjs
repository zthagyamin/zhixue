import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {drawFlashcardMasks,verifyFlashcardImage} from '../app/flashcard-occlusion.ts';
import {tsxFunction} from './fixtures/tsx-functions.mjs';
const support={schemaVersion:1,type:'flashcard',mode:'occlusion',sourceKey:'a'.repeat(64),sourceVersion:'b'.repeat(64),assetId:'diagram',assetVersion:'c'.repeat(64),activeMaskId:'a',parentId:'old',masks:['a','b'].map((id,i)=>({id,x:String(10+i*30),y:'10',width:'20',height:'20',answer:'Never render '+id}))};
test('canvas front paints every opaque mask, reveal removes only the target mask',()=>{
 const calls=[];const ctx={drawImage:()=>calls.push('source'),fillRect:(...args)=>calls.push(['mask',ctx.fillStyle,...args]),fillText:text=>calls.push(['text',text])};const canvas={getContext:()=>ctx};
 drawFlashcardMasks(canvas,{},100,100,support,false);assert.equal(calls[0],'source');assert.equal(calls.filter(v=>v[0]==='mask').length,2);assert.equal(JSON.stringify(calls).includes('Never render'),false);
 calls.length=0;drawFlashcardMasks(canvas,{},100,100,support,true);assert.deepEqual(calls,['source',['mask','#25302d',40,10,20,20]]);
 assert.throws(()=>drawFlashcardMasks(canvas,{},9000,9000,support,false));
});
test('image validation checks content hash, version and MIME before decoding',async()=>{
 const raw=Buffer.from('fixture');const assetVersion=createHash('sha256').update(raw).digest('hex');const asset={assetId:'diagram',sourceVersion:support.sourceVersion,assetVersion,mime:'image/png',data:raw.toString('base64')};
 assert.equal((await verifyFlashcardImage(asset,{...support,assetVersion})).size,raw.length);
 for(const delta of [{assetId:'different'},{mime:'image/svg+xml'},{data:Buffer.from('changed').toString('base64')},{sourceVersion:'0'.repeat(64)}])await assert.rejects(verifyFlashcardImage({...asset,...delta},{...support,assetVersion}));
});
test('actual flashcard grading rejects hidden answers, stale source and duplicate clicks',()=>{
 const file=new URL('../app/plugins/plugin-flashcard.tsx',import.meta.url);
 for(const [showAnswer,current,expected] of [[false,true,0],[true,false,0],[true,true,1]]){
  let count=0;const grade=tsxFunction(file,'handleGrade',{showAnswer,consumed:{current:false},context:{paperServices:{isCurrent:()=>current}},onGrade:()=>count++,setIsFlipped:()=>{},setSubmitted:()=>{}});
  grade('good');grade('good');assert.equal(count,expected);
 }
});
