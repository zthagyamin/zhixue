import test from 'node:test';
import assert from 'node:assert/strict';
import {parseLearningSupport} from '../app/learning-support.ts';
import {evaluateSpellingComposition} from '../app/plugins/spelling-core.ts';
import {sealStudyItem,studyCompatibleModes} from '../app/account-study-content.ts';
import {wordBody} from './fixtures/account-study-fixtures.mjs';
import {spawnSync} from 'node:child_process';
const support={schemaVersion:1,type:'spelling',word:'ship',segments:[{letters:'sh',phoneme:'ʃ',isTricky:true},{letters:'i',phoneme:'ɪ'},{letters:'p',phoneme:'p'}]};
test('spelling mappings are explicit, closed and cover the exact word',()=>{
 assert.deepEqual(parseLearningSupport(support,'spelling'),support);
 for(const value of [{...support,word:'shop'},{...support,segments:[]},{...support,segments:[{letters:'ship',phoneme:''}]},{...support,segments:[{letters:'ship',phoneme:'\ufeff'}]},{...support,guess:true}])assert.throws(()=>parseLearningSupport(value,'spelling'));
});
test('spelling content hash, exact word and available modes agree across runtimes',async()=>{
 const body=wordBody({schemaVersion:2,recommendedPlugin:'spelling',completionRule:'graded-practice',learningSupport:support});body.word.word='ship';
 const python=process.env.PYTHON||process.env.GATEWAY_TEST_PYTHON||(process.platform==='win32'?'py':'python');
 const script="import sys,json;sys.path.insert(0,'companion');from account_sync_schema import seal_item,compatible_modes;v=json.load(sys.stdin);i=seal_item(v);print(json.dumps({'item':i,'modes':compatible_modes(i)}))";
 const result=spawnSync(python,['-c',script],{encoding:'utf8',input:JSON.stringify(body),env:{...process.env,PYTHONUTF8:'1'},timeout:10000});assert.equal(result.status,0,result.stderr);
 const output=JSON.parse(result.stdout);assert.deepEqual(output.item,await sealStudyItem(body));assert.deepEqual(output.modes,['spelling']);assert.deepEqual(studyCompatibleModes(body),['spelling']);
 await assert.rejects(()=>sealStudyItem({...body,word:{...body.word,word:'shop'}}),/mapping-mismatch/);
});
test('composition ignores intermediate non-English text and preserves suffix/error rules',()=>{
 const state={word:'ship',input:'s',wrong:'',wrongCount:0};
 assert.equal(evaluateSpellingComposition(state,'s诗'),state);
 assert.equal(evaluateSpellingComposition(state,'ship'),state);
 assert.equal(evaluateSpellingComposition(state,'sh').input,'sh');
 const wrong=evaluateSpellingComposition(state,'sx');assert.equal(wrong.wrongCount,1);
 assert.equal(evaluateSpellingComposition(wrong,'s').wrong,'');
});
