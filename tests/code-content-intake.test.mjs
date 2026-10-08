import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {sealStudyItem} from '../app/account-study-content.ts';
import {quizBody} from './fixtures/account-study-fixtures.mjs';

const body=()=>quizBody({schemaVersion:2,learningSupport:{schemaVersion:1,type:'code',functionNames:['add'],cases:[{id:'sum',functionName:'add',args:[1,2],expected:3}]},
    practice:{itemId:'add',abilityId:'addition',domain:'python',questionType:'code',prompt:'编写 add(a,b)。',sourceLabel:'Synthetic',initialCode:'def add(a,b):\n    pass',testCode:''}});
test('real portable code intake accepts structured cases without a legacy assertion script',async()=>{
    const item=await sealStudyItem(body());assert.equal(item.practice.testCode,'');assert.equal(item.learningSupport.type,'code');
    const absent=body();delete absent.practice.testCode;assert.equal((await sealStudyItem(absent)).practice.questionType,'code');
    const invalid=body();invalid.learningSupport.cases=[];await assert.rejects(()=>sealStudyItem(invalid));
    const legacy=body();legacy.schemaVersion=1;delete legacy.learningSupport;await assert.rejects(()=>sealStudyItem(legacy),/incomplete-code/);
});
test('actual Node and Companion source sealing agree for structured-only programming material',async()=>{
    const input=body();
    const result=spawnSync(process.env.PYTHON||'python',['-X','utf8','-c',"import json,sys;sys.path.insert(0,'companion');from account_sync_schema import seal_item;print(json.dumps(seal_item(json.load(sys.stdin)),ensure_ascii=True))"],
        {input:JSON.stringify(input),encoding:'utf8',windowsHide:true,timeout:10000});
    assert.equal(result.status,0,result.stderr||result.error?.message);
    assert.deepEqual(JSON.parse(result.stdout),await sealStudyItem(input));
});
