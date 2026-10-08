import test from 'node:test';import assert from 'node:assert/strict';
import {parseLearningSupport,recallCoverage,capRecallRating} from '../app/learning-support.ts';
import {sealStudyItem,parseStudyItem} from '../app/account-study-content.ts';
import {quizBody} from './fixtures/account-study-fixtures.mjs';
export const support={schemaVersion:1,type:'recall',criteria:[{id:'mechanism',text:'Explain the mechanism',weight:2,mandatory:true},{id:'boundary',text:'State the boundary'}],hints:['Think about the cause.','Connect cause to ___.','The complete reference explanation.']};
test('recall support validates bounded unique criteria and three nonempty hints',()=>{
 assert.deepEqual(parseLearningSupport(support,'recall'),support);
 assert.throws(()=>parseLearningSupport({...support,criteria:[support.criteria[0],support.criteria[0]]},'recall'));
 assert.throws(()=>parseLearningSupport({...support,criteria:[{...support.criteria[0],weight:0}]},'recall'));
 assert.throws(()=>parseLearningSupport({...support,hints:['one','two']},'recall'));
 assert.throws(()=>parseLearningSupport(support,'quiz'));
});
test('coverage is weighted, mandatory misses remain visible, and unknown point IDs cannot inflate it',()=>{
 const value=recallCoverage(support.criteria,['boundary','unknown','boundary']);assert.equal(value.percent,33);assert.deepEqual(value.missingMandatory,['mechanism']);
 assert.equal(recallCoverage([],[]).percent,null);
});
test('only pre-answer hints cap a rating; post-answer checking uses pre-answer level zero',()=>{
 assert.equal(capRecallRating('easy',0),'easy');assert.equal(capRecallRating('good',1),'good');assert.equal(capRecallRating('easy',2),'hard');assert.equal(capRecallRating('hard',3),'again');assert.equal(capRecallRating('again',2),'again');
});
test('version two content carries support without changing legacy hashes or allowing it in version one',async()=>{
 const legacy=quizBody();const before=await sealStudyItem(legacy);assert.deepEqual(await parseStudyItem(before),before);
 const next={...legacy,schemaVersion:2,learningSupport:support,practice:{...legacy.practice,questionType:'recall',answer:'Reference'}};delete next.practice.options;
 const item=await sealStudyItem(next);assert.deepEqual((await parseStudyItem(item)).learningSupport,support);
 await assert.rejects(sealStudyItem({...next,schemaVersion:1}),/field|version/);
 assert.equal((await sealStudyItem(legacy)).contentHash,before.contentHash);
});

test('fractional weights are rejected at the source gate before integer-only content hashing',()=>{
 assert.throws(()=>parseLearningSupport({...support,criteria:[{id:'half',text:'Half',weight:0.5}]},'recall'),/weight/);
});
