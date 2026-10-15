import test from 'node:test';
import assert from 'node:assert/strict';
import {createLocalPaperReadingAi} from '../src/infrastructure/paper-reading/index.ts';
const unit={schemaVersion:1,unitId:'unit',title:'Paper',goal:'Explain mechanism',source:{ownerId:'private-owner',libraryId:'local:l',materialFingerprint:'a'.repeat(64),sourceVersion:'b'.repeat(64),sectionId:'s',paragraphs:[{id:'p',rawEn:'ReLU avoids saturation for positive inputs.'}]}};
const candidate={status:'ready',ability:'mechanism',question:'Why does ReLU help on positive inputs?',reference:[{point:'Avoid saturation.',paragraphId:'p',quote:'avoids saturation'}],quality:{sourceSufficient:true,taskSpecific:true,referenceConsistent:true,missingVisuals:false}};
test('local AI uses existing configured stream without sending owner identity and requires complete output',async()=>{
 let sent;const settings={enabled:true,configured:true,provider:'chatgpt',model:'synthetic',revision:1};
 const service={async *chat(request){sent=request;yield {type:'delta',text:JSON.stringify(candidate)};yield {type:'done'};}};
 const ai=createLocalPaperReadingAi(()=>({service,settings}),()=>true);const task=await ai.prepare(unit,'prepare',new AbortController().signal);
 assert.equal(task.status,'ready');assert.equal(JSON.stringify(sent).includes('private-owner'),false);assert.equal(sent.provider,'chatgpt');
 const partial={async *chat(){yield {type:'delta',text:JSON.stringify(candidate)};}};
 await assert.rejects(createLocalPaperReadingAi(()=>({service:partial,settings}),()=>true).prepare(unit,'p',new AbortController().signal),/incomplete/);
});
test('scope or settings changes and unavailable configuration cannot yield a usable question',async()=>{
 let current=true;const settings={enabled:true,configured:true,provider:'chatgpt',model:'synthetic',revision:1};
 const service={async *chat(){current=false;yield {type:'delta',text:JSON.stringify(candidate)};yield {type:'done'};}};
 await assert.rejects(createLocalPaperReadingAi(()=>({service,settings}),()=>current).prepare(unit,'p',new AbortController().signal),/cancel/);
 await assert.rejects(createLocalPaperReadingAi(()=>null,()=>true).prepare(unit,'p',new AbortController().signal),/unavailable/);
});
