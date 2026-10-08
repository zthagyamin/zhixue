import test from 'node:test';
import assert from 'node:assert/strict';
import {parseLearningSupport} from '../app/learning-support.ts';
import {gradeQuizSelection,mergeStemHighlight} from '../app/quiz-support.ts';
import {sealStudyItem,studyCompatibleModes} from '../app/account-study-content.ts';
import {quizBody} from './fixtures/account-study-fixtures.mjs';
import {spawnSync} from 'node:child_process';
const support={schemaVersion:1,type:'quiz',selection:'multiple',options:[{optionId:'a',text:'Same'},{optionId:'b',text:'Same'},{optionId:'c',text:'Third',trapType:'out_of_scope',trapExplanation:'Not in the source.'}],correctOptionIds:['a','b']};
test('multiple choice uses exact ID sets, including duplicate display text and reordered options',()=>{
 assert.deepEqual(parseLearningSupport(support,'quiz'),support);
 assert.equal(gradeQuizSelection(support,['b','a']),true);
 for(const selected of [[],['a'],['a','b','c'],['a','a'],['missing']])assert.equal(gradeQuizSelection(support,selected),false);
 assert.equal(gradeQuizSelection({...support,options:[...support.options].reverse()},['a','b']),true);
});
test('versioned quiz content has one answer source and identical cross-runtime hashes',async()=>{
 const body=quizBody({schemaVersion:2,learningSupport:support});delete body.practice.options;delete body.practice.answer;
 const python=process.env.PYTHON||process.env.GATEWAY_TEST_PYTHON||(process.platform==='win32'?'py':'python');
 const script="import sys,json;sys.path.insert(0,'companion');from account_sync_schema import seal_item,compatible_modes;v=json.load(sys.stdin);i=seal_item(v);print(json.dumps({'item':i,'modes':compatible_modes(i)}))";
 const result=spawnSync(python,['-c',script],{encoding:'utf8',input:JSON.stringify(body),env:{...process.env,PYTHONUTF8:'1'},timeout:10000});assert.equal(result.status,0,result.stderr);
 const output=JSON.parse(result.stdout);assert.deepEqual(output.item,await sealStudyItem(body));assert.deepEqual(output.modes,['quiz']);assert.deepEqual(studyCompatibleModes(body),['quiz']);
 await assert.rejects(()=>sealStudyItem({...body,practice:{...body.practice,answer:0}}),/duplicate-quiz-answer-source/);
});
test('stem highlights merge by offsets without mutating old draft ranges',()=>{
 const old=[{start:2,end:5}];assert.deepEqual(mergeStemHighlight(old,{start:4,end:8},10),[{start:2,end:8}]);assert.deepEqual(old,[{start:2,end:5}]);assert.deepEqual(mergeStemHighlight(old,{start:-1,end:8},10),old);
});
test('closed quiz metadata rejects duplicate identities and ambiguous answer sources',()=>{
 for(const value of [{...support,selection:'single'},{...support,options:[support.options[0],support.options[0]]},{...support,correctOptionIds:['missing']},{...support,answer:'Same'},{...support,options:[{...support.options[0],isCorrect:true},support.options[1]]}])assert.throws(()=>parseLearningSupport(value,'quiz'));
});
test('single choice accepts exactly one correct ID and rejects extra selections',()=>{
 const single={...support,selection:'single',correctOptionIds:['b']};assert.deepEqual(parseLearningSupport(single,'quiz'),single);assert.equal(gradeQuizSelection(single,['b']),true);assert.equal(gradeQuizSelection(single,['a','b']),false);assert.equal(gradeQuizSelection(single,['a']),false);
});
