import test from 'node:test';
import assert from 'node:assert/strict';
import {matchTrialMaterials} from '../app/saved-note-trials.ts';
import {markTrialForRetry,trialRetryQueue} from '../app/trial-review.ts';

const questions=[{id:'q1',prompt:'第一题'},{id:'q2',prompt:'第二题'},{id:'q3',prompt:'第三题'}];
test('material discovery matches subject, title and source, with normalized whitespace and case',()=>{
 const items=[{id:'a',subject:'经济学',title:'Opportunity Cost',questions:[{filename:'Lecture-01.md'}]}, {id:'b',subject:'数学',title:'导数',questions:[]}];
 for(const query of ['经济学',' opportunity COST ','lecture-01'])assert.deepEqual(matchTrialMaterials(items,query).map(x=>x.id),['a']);
 assert.deepEqual(matchTrialMaterials(items,'不存在'),[]);
 assert.deepEqual(matchTrialMaterials(items,'  '),items);
});
test('retry only includes explicitly marked questions in source order without duplicates',()=>{
 let marked=markTrialForRetry([], 'q3',true);
 marked=markTrialForRetry(marked,'q1',true);
 marked=markTrialForRetry(marked,'q1',true);
 assert.deepEqual(trialRetryQueue(questions,[...marked,'unknown']),[0,2]);
 marked=markTrialForRetry(marked,'q1',false);
 assert.deepEqual(trialRetryQueue(questions,marked),[2]);
 assert.deepEqual(trialRetryQueue(questions,[]),[]);
 assert.deepEqual(questions.map(q=>Object.keys(q)),Array(3).fill(['id','prompt']));
});
