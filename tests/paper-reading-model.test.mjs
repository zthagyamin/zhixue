import test from 'node:test';
import assert from 'node:assert/strict';
import {paperReadingPreparation,paperReadingModelEvaluation} from '../src/domain/paper-reading/model-output.ts';
const unit={schemaVersion:1,unitId:'u',title:'Paper',goal:'Explain mechanism',source:{ownerId:'account:u',libraryId:'account:l',materialFingerprint:'a'.repeat(64),sourceVersion:'b'.repeat(64),sectionId:'s',paragraphs:[{id:'p',rawEn:'ReLU avoids saturation for positive inputs.'}]}};
const candidate={status:'ready',ability:'mechanism',question:'Why does ReLU help on positive inputs?',reference:[{point:'Avoid saturation.',paragraphId:'p',quote:'avoids saturation'}],quality:{sourceSufficient:true,taskSpecific:true,referenceConsistent:true,missingVisuals:false}};
const task=()=>paperReadingPreparation(candidate,unit,'task');
test('source-bounded preparation rejects ungrounded reference and insufficient visuals',()=>{
 assert.equal(task().status,'ready');
 assert.equal(paperReadingPreparation({...candidate,quality:{...candidate.quality,missingVisuals:true}},unit,'t').status,'needs-improvement');
 assert.equal(paperReadingPreparation({...candidate,reference:[{...candidate.reference[0],quote:'imagined'}]},unit,'t').status,'needs-improvement');
 assert.throws(()=>paperReadingPreparation({...candidate,rating:'good'},unit,'t'),/unknown-study-field/);
});
test('resolved model feedback requires source and answer evidence for every reference point',()=>{
 const answer='It avoids saturation.',raw={status:'resolved',outcome:'correct',matches:[{pointIndex:0,sourceQuote:'avoids saturation',answerQuote:'avoids saturation',reason:'The explanation identifies the mechanism.'}],issues:[],explanation:'Positive inputs keep a nonzero gradient.'};
 assert.equal(paperReadingModelEvaluation(raw,task(),answer).outcome,'correct');
 assert.equal(paperReadingModelEvaluation({...raw,matches:[]},task(),answer).status,'pending');
 assert.equal(paperReadingModelEvaluation({...raw,matches:[{...raw.matches[0],answerQuote:'made up'}]},task(),answer).status,'pending');
 assert.equal(paperReadingModelEvaluation({...raw,matches:[{...raw.matches[0],sourceQuote:'made up'}]},task(),answer).status,'pending');
});
test('missing mechanism yields a specific issue while malformed/conflicting feedback abstains',()=>{
 const raw={status:'resolved',outcome:'incorrect',matches:[],issues:[{pointIndex:0,sourceQuote:'avoids saturation',kind:'missing',reason:'No explanation of saturation.'}],explanation:'Explain how positive inputs avoid saturation.'};
 assert.equal(paperReadingModelEvaluation(raw,task(),'I forgot').outcome,'incorrect');
 assert.equal(paperReadingModelEvaluation({...raw,outcome:'correct'},task(),'I forgot').status,'pending');
 assert.equal(paperReadingModelEvaluation({confidence:0.99,rating:'good'},task(),'long answer').status,'pending');
});
