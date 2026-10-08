import assert from 'node:assert/strict';
import test from 'node:test';
import {quizBody,wordBody,snapshotBody} from './fixtures/account-study-fixtures.mjs';

let api;
try {api=await import('../app/account-study-content.ts');}
catch(error) {if(error.code!=='ERR_MODULE_NOT_FOUND') throw error;}
function ready(){assert.equal(typeof api?.sealStudyItem,'function','Portable content validation must exist');}

test('portable quiz retains answer index zero and rejects later content changes',async()=>{
  ready();const item=await api.sealStudyItem(quizBody());
  assert.equal(item.practice.answer,0);assert.match(item.contentHash,/^[a-f0-9]{64}$/);
  assert.deepEqual(await api.parseStudyItem(item),item);
  await assert.rejects(api.parseStudyItem({...item,title:'changed'}),/integrity/);
});
test('item hashing ignores object insertion order and returns detached content',async()=>{
  ready();const body=quizBody(),item=await api.sealStudyItem(body);
  const other=await api.sealStudyItem(Object.fromEntries(Object.entries(body).reverse()));
  assert.equal(item.contentHash,other.contentHash);
  body.practice.options[0]='mutated';assert.equal(item.practice.options[0],'First');
});
for(const field of ['sourceNote','stateRef','localPath','apiKey','token']) {
  test(`content rejects nested local field ${field} rather than publishing it`,async()=>{
    ready();const body=quizBody();body.practice[field]='private-value';
    await assert.rejects(api.sealStudyItem(body),/field/);
  });
}
test('word snapshots preserve full three-stage content but never browser stage',async()=>{
  ready();const body=wordBody(),item=await api.sealStudyItem(body);
  assert.equal(item.word.meaning,'树');assert.equal(item.language,'en');
  body.word.stage=2;await assert.rejects(api.sealStudyItem(body),/field/);
});
for(const field of ['meaning','example']) {
  test(`word missing ${field} is incomplete, not a publishable word`,async()=>{
    ready();const body=wordBody();delete body.word[field];await assert.rejects(api.sealStudyItem(body),/missing|invalid/);
  });
}
test('code item requires executable test material and quiz index stays in range',async()=>{
  ready();const body=quizBody();body.practice={itemId:'question-one',abilityId:'coding',domain:'python',
    questionType:'code',prompt:'Implement add.',sourceLabel:'Python',initialCode:'def add(a,b): pass'};
  await assert.rejects(api.sealStudyItem(body),/code/);
  body.practice.testCode='assert add(1,2)==3';assert.equal((await api.sealStudyItem(body)).practice.questionType,'code');
  const quiz=quizBody();quiz.practice.answer=2;await assert.rejects(api.sealStudyItem(quiz),/answer/);
});
test('decimal answers are portable strings and non-integer numeric payloads are rejected',async()=>{
  ready();const body=quizBody();body.practice.questionType='calculation';delete body.practice.options;body.practice.answer='1.25';
  assert.equal((await api.sealStudyItem(body)).practice.answer,'1.25');
  body.practice.answer=1.25;await assert.rejects(api.sealStudyItem(body),/answer/);
});
test('item rejects wrong version, blank language and oversized text',async()=>{
  ready();await assert.rejects(api.sealStudyItem(wordBody({schemaVersion:2})),/version/);
  await assert.rejects(api.sealStudyItem(wordBody({language:''})),/language/);
  const body=quizBody();body.practice.prompt='x'.repeat(70000);await assert.rejects(api.sealStudyItem(body),/size|large|long/);
});
test('complete bundle pins ordered membership and rejects missing or extra content',async()=>{
  ready();const items=await Promise.all([wordBody(),quizBody()].map(api.sealStudyItem));
  const snapshot=await api.sealStudySnapshot(snapshotBody(items));
  const bundle=await api.validateStudyBundle({snapshot,items});assert.equal(bundle.snapshot.items[0].itemKey,'word:tree');
  await assert.rejects(api.validateStudyBundle({snapshot,items:[items[0]]}),/incomplete/);
  await assert.rejects(api.validateStudyBundle({snapshot,items:[...items,items[0]]}),/duplicate|incomplete/);
});
test('snapshot rejects duplicate identity, invalid cursors, unknown ownership and changed manifest',async()=>{
  ready();const item=await api.sealStudyItem(quizBody());
  await assert.rejects(api.sealStudySnapshot(snapshotBody([item,item])),/duplicate/);
  await assert.rejects(api.sealStudySnapshot(snapshotBody([item],{eventCursor:-1})),/cursor/);
  await assert.rejects(api.sealStudySnapshot(snapshotBody([item],{userId:'account-a'})),/field/);
  const snapshot=await api.sealStudySnapshot(snapshotBody([item]));snapshot.taskCursor=2;
  await assert.rejects(api.validateStudyBundle({snapshot,items:[item]}),/integrity/);
});
test('member hashes must match actual immutable content and empty snapshots stay explicitly empty',async()=>{
  ready();const item=await api.sealStudyItem(quizBody());
  const snapshot=await api.sealStudySnapshot(snapshotBody([item],{items:[{itemKey:item.itemKey,contentHash:'b'.repeat(64)}]}));
  await assert.rejects(api.validateStudyBundle({snapshot,items:[item]}),/membership/);
  const empty=await api.sealStudySnapshot(snapshotBody([]));
  assert.deepEqual((await api.validateStudyBundle({snapshot:empty,items:[]})).items,[]);
});
test('array-shaped enum values cannot bypass item or question-specific validation',async()=>{
  ready();await assert.rejects(api.sealStudyItem(quizBody({eventKind:['due']})),/kind/);
  const body=quizBody();body.practice.questionType=['code'];delete body.practice.options;delete body.practice.answer;
  await assert.rejects(api.sealStudyItem(body),/question-type/);
});
for(const questionType of ['recall','calculation','flashcard']) {
  test(`${questionType} without reference material is not a complete publishable question`,async()=>{
    ready();const body=quizBody();body.practice.questionType=questionType;
    delete body.practice.options;delete body.practice.answer;delete body.practice.explanation;
    await assert.rejects(api.sealStudyItem(body),/reference/);
    body.practice.reviewPoint='A verified reference.';
    assert.equal((await api.sealStudyItem(body)).practice.reviewPoint,'A verified reference.');
  });
}
test('item wire budget includes its hash so every sealed boundary item can round trip',async()=>{
  ready();const body=quizBody();body.practice.prompt='p'.repeat(32000);body.practice.explanation='e'.repeat(32000);body.practice.reviewPoint='';
  body.practice.reviewPoint='r'.repeat(65536-40-Buffer.byteLength(JSON.stringify(body)));
  await assert.rejects(api.sealStudyItem(body),/too-large/);
  body.practice.reviewPoint=body.practice.reviewPoint.slice(100);
  const item=await api.sealStudyItem(body);assert.deepEqual(await api.parseStudyItem(item),item);
});
test('snapshot wire budget includes its hash',async()=>{
  ready();const refs=Array.from({length:9000},(_,i)=>({itemKey:`id-${i}-`,contentHash:'a'.repeat(64)}));
  const body=snapshotBody([],{items:refs});let remaining=2097152-40-Buffer.byteLength(JSON.stringify(body));
  for(const ref of refs){const n=Math.min(200-ref.itemKey.length,remaining);ref.itemKey+='x'.repeat(n);remaining-=n;}
  assert.equal(remaining,0);
  await assert.rejects(api.sealStudySnapshot(body),/too-large/);
});
test('validated bundle normalizes item transport order to its immutable manifest',async()=>{
  ready();const items=await Promise.all([wordBody(),quizBody()].map(api.sealStudyItem));
  const snapshot=await api.sealStudySnapshot(snapshotBody(items));
  const result=await api.validateStudyBundle({snapshot,items:[...items].reverse()});
  assert.deepEqual(result.items.map(item=>item.itemKey),['word:tree','question-one']);
});

test('two-column vocabulary keeps existing recall fallback and spelling without invented examples',async()=>{
  ready();const body=wordBody({recommendedPlugin:'three-stage',completionRule:'graded-practice'});body.word.example='';body.word.context='';
  const item=await api.sealStudyItem(body);
  assert.equal(item.word.example,'');assert.equal(api.defaultStudyPracticeMode(item),'recall');
  assert.deepEqual(api.studyCompatibleModes(item),['recall','flashcard','spelling']);
  await assert.rejects(api.sealStudyItem({...body,completionRule:'three-stage'}),/rule/);
});

test('explicit spelling recommendation survives portable publication',async()=>{
  ready();const item=await api.sealStudyItem(wordBody({recommendedPlugin:'spelling',completionRule:'graded-practice'}));
  assert.equal(api.defaultStudyPracticeMode(item),'spelling');
  assert.ok(api.studyCompatibleModes(item).includes('three-stage'));
});
