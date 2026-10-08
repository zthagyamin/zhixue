import test from 'node:test';
import assert from 'node:assert/strict';
import {createLearningDraftStore} from '../app/learning-draft-store.ts';
import {tsxHandler} from './fixtures/tsx-handlers.mjs';

test('another pending save cannot consume a flashcard before its grade is accepted',()=>{
 const store=createLearningDraftStore('fixture'),first=store.adapter('first','flashcard'),next=store.adapter('next','flashcard');
 const ticket=first.begin(),consumed={current:false};let grades=0,submitted=false;
 const grade=tsxHandler(new URL('../app/plugins/plugin-flashcard.tsx',import.meta.url),'handleGrade',{showAnswer:true,consumed,context:{draft:next},setSubmitted:value=>submitted=value,setIsFlipped(){},onGrade(){const accepted=next.begin();if(accepted){grades++;store.commit(accepted);}}});
 grade('good');assert.equal(consumed.current,false);assert.equal(submitted,false);assert.equal(grades,0);
 store.commit(ticket);grade('good');assert.equal(grades,1);assert.equal(consumed.current,true);
});
