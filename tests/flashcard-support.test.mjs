import test from 'node:test';
import assert from 'node:assert/strict';
import {parseLearningSupport} from '../app/learning-support.ts';
import {flashcardChildId} from '../app/flashcard-support.ts';
import {sealStudyItem,studyCompatibleModes} from '../app/account-study-content.ts';
import {quizBody} from './fixtures/account-study-fixtures.mjs';
import {spawnSync} from 'node:child_process';
const mask={id:'label-a',x:'10',y:'20',width:'25.5',height:'12',answer:'线粒体'};
const support={schemaVersion:1,type:'flashcard',mode:'occlusion',sourceKey:'a'.repeat(64),sourceVersion:'b'.repeat(64),assetId:'diagram',assetVersion:'c'.repeat(64),masks:[mask]};
test('closed flashcard contract refuses URLs, transparent/invalid masks and duplicate IDs',()=>{
 assert.deepEqual(parseLearningSupport(support,'flashcard'),support);
 for(const v of [{...support,url:'https://example.com/img.png'},{...support,sourceKey:'../x'},{...support,masks:[mask,mask]},{...support,masks:[{...mask,x:'90'}]},{...support,masks:[{...mask,width:'0'}]},{...support,masks:[{...mask,x:10}]},{...support,activeMaskId:'missing',parentId:'p'}])assert.throws(()=>parseLearningSupport(v,'flashcard'));
 assert.throws(()=>parseLearningSupport(support,'recall'));
});
test('stable child identity and expanded content agree across Python and TypeScript',async()=>{
 const learningSupport={schemaVersion:1,type:'flashcard',mode:'bidirectional',direction:'reverse',parentId:'old-card'};
 const body=quizBody({schemaVersion:2,learningSupport});body.practice={...body.practice,questionType:'flashcard',prompt:'背面',answer:'正面'};delete body.practice.options;
 const python=process.env.PYTHON||process.env.GATEWAY_TEST_PYTHON||(process.platform==='win32'?'py':'python');
 const script="import sys,json;sys.path.insert(0,'companion');from flashcard_support import child_id;from account_sync_schema import seal_item,compatible_modes;v=json.load(sys.stdin);i=seal_item(v);print(json.dumps({'id':child_id('old-card','reverse'),'item':i,'modes':compatible_modes(i)}))";
 const result=spawnSync(python,['-c',script],{encoding:'utf8',input:JSON.stringify(body),env:{...process.env,PYTHONUTF8:'1'},timeout:10000});assert.equal(result.status,0,result.stderr);
 const output=JSON.parse(result.stdout);assert.equal(output.id,await flashcardChildId('old-card','reverse'));assert.deepEqual(output.item,await sealStudyItem(body));assert.deepEqual(output.modes,['flashcard']);assert.deepEqual(studyCompatibleModes(body),['flashcard']);
});
