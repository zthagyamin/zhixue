import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {isRecallEcho} from '../src/domain/content/index.ts';
import {recallReference,checkContentQuality} from '../src/domain/assessment/index.ts';

const fixture=JSON.parse(readFileSync(new URL('./fixtures/reference-echo-v1.json',import.meta.url),'utf8'));
assert.equal(fixture.version,'reference-echo-v1');
for(const row of fixture.cases)test(`reference formatting: ${row.id}`,()=>{
  assert.equal(isRecallEcho(row.reference,row.prompt),row.echo);
});

test('formatted question echoes are rejected in every supplied reference candidate',()=>{
  const data=Object.freeze({prompt:'BN vs LN？',answer:'`BN vs LN`',explanation:'**BN vs LN**',reviewPoint:'__BN vs LN__'});
  assert.equal(recallReference(data,[{text:'**BN vs LN**'}],'`BN vs LN`'),null);
  assert.equal(checkContentQuality('recall',data).capabilities.canAutoAssess,false);
  assert.equal(recallReference({...data,answer:'归一化维度不同。'}),'归一化维度不同。');
});

test('plain and formatted duplicate flashcards cannot produce a self-assessment',()=>{
  for(const back of ['BN vs LN','**BN vs LN**','`BN vs LN`']){
    const data=Object.freeze({front:'BN vs LN？',back});
    const result=checkContentQuality('flashcard',data);
    assert.deepEqual(result.capabilities,{canDisplay:true,canSelfCheck:false,canAutoAssess:false});
    assert.ok(result.issues.some(issue=>issue.code==='echoed-flashcard-reference'));
  }
});

test('valid flashcard references preserve numeric zero and mathematical distinctions',()=>{
  for(const [front,back] of [['结果是多少？',0],['x**2','x2'],['x²','x2'],['x+1','x-1'],['X','x'],['Q','有依据的答案']]){
    assert.equal(checkContentQuality('flashcard',{front,back}).capabilities.canSelfCheck,true);
  }
});
