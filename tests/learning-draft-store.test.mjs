import assert from 'node:assert/strict';
import test from 'node:test';
import {learningDraftItemId} from '../app/learning-draft-store.ts';
let create;
try{create=(await import('../app/learning-draft-store.ts')).createLearningDraftStore;}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
const store=()=>{assert.equal(typeof create,'function');return create();};

test('source preparation can detect edits to an already dirty answer without subscribing to keystrokes',()=>{
 const s=store(),input=s.adapter('a','recall');input.write('answer','first');
 const revision=s.getSnapshot(),version=s.getMutationVersion();input.write('answer','second');
 assert.equal(s.getSnapshot(),revision);assert.notEqual(s.getMutationVersion(),version);
});

test('resetting original content clears its grouped feedback and drafts, preserving other content',()=>{
 const s=store(),a=s.adapter('group-a/item','calculation','A','base-a'),b=s.adapter('group-b/item','recall','A','base-a'),other=s.adapter('group-a/other','recall','B','base-b');
 a.write('answer','first');b.write('answer','second');other.write('answer','keep');let continued=0;
 assert.equal(s.commit(a.begin(),()=>continued++),true);s.clearItem('base-a');
 assert.equal(a.hasSavedFeedback(),false);assert.equal(a.continueAfterFeedback(),false);assert.equal(b.read('answer',''),'');
 assert.equal(a.write('answer','old'),false);assert.equal(b.begin(),null);assert.equal(continued,0);
 assert.equal(other.read('answer',''),'keep');assert.equal(other.write('answer','still live'),true);
 assert.equal(s.adapter('group-a/item','calculation','A','base-a').write('answer','fresh'),true);
});

test('resetting original content retires grouped adapters that have never materialized an entry',async()=>{
 const s=store(),stale=s.adapter('group-a/item','calculation','A','base-a');s.clearItem('base-a');let executed=0;
 assert.equal(stale.write('answer','stale'),false);assert.equal(stale.begin(),null);
 assert.equal((await s.submit(stale,{intent:'good',current:()=>true,execute(){executed++;}})).status,'stale');assert.equal(executed,0);
 const fresh=s.adapter('group-a/item','calculation','A','base-a');assert.ok(fresh.begin());
});
test('memory drafts retain input and grading flags across matching mounts and modes',()=>{
  const s=store(),spelling=s.adapter('owner:item:hash','spelling:1');
  spelling.write('state',{input:'ca',wrong:'x',wrongCount:3});
  s.adapter('owner:item:hash','quiz:1').write('failedOnce',true);
  assert.deepEqual(s.adapter('owner:item:hash','spelling:1').read('state',{}),{input:'ca',wrong:'x',wrongCount:3});
  assert.equal(s.adapter('owner:item:hash','quiz:1').read('failedOnce',false),true);
});
test('draft reads are isolated by source identity and do not expose mutable stored references',()=>{
  const s=store(),a=s.adapter('accountA:item:hashA','recall:1');a.write('answer',{points:['first']});
  const copy=a.read('answer',{});copy.points.push('changed');assert.deepEqual(a.read('answer',{}),{points:['first']});
  assert.equal(s.adapter('accountB:item:hashA','recall:1').read('answer',null),null);
  assert.equal(s.adapter('accountA:item:hashB','recall:1').read('answer',null),null);
});
test('submission freezes stale writes and local success clears sibling modes without waiting for delivery',()=>{
  const s=store(),a=s.adapter('item','recall:1'),other=s.adapter('item','flashcard:1');a.write('answer','draft');other.write('flipped',true);
  const ticket=a.begin();assert.ok(ticket);assert.equal(s.isPending(),true);
  assert.equal(a.write('answer','late reset'),false);assert.equal(s.adapter('different','quiz:1').begin(),null);
  assert.equal(s.commit(ticket),true);assert.equal(s.isPending(),false);
  assert.equal(s.adapter('item','recall:1').read('answer',null),null);
  assert.equal(s.adapter('item','flashcard:1').read('flipped',false),false);
  assert.equal(a.write('answer','stale unmount'),false);
});
test('a failed local save retains the same attempt and its penalty flags',()=>{
  const s=store(),a=s.adapter('item','quiz:1');a.write('failedOnce',true);a.write('lapseInput','corrected answer');
  const ticket=a.begin();assert.equal(s.fail(ticket),true);assert.equal(s.isPending(),false);
  const restored=s.adapter('item','quiz:1');assert.equal(restored.read('failedOnce',false),true);assert.equal(restored.read('lapseInput',''),'corrected answer');
  assert.ok(restored.begin());
});
test('late success after explicit clear cannot delete a newer generation',()=>{
  const s=store(),old=s.adapter('item','code:1');old.write('code','first');const ticket=old.begin();
  s.clearItem('item');const fresh=s.adapter('item','code:1');fresh.write('code','new draft');
  assert.equal(s.commit(ticket),false);assert.equal(fresh.read('code',''),'new draft');assert.equal(old.write('code','late'),false);
});
test('clearing or disposing invalidates old adapters and pending completion tickets',()=>{
  for(const action of ['clear','dispose']){const s=store(),a=s.adapter('item','three-stage:1');a.write('learned',true);const ticket=a.begin();s[action]();
    assert.equal(s.commit(ticket),false);assert.equal(a.write('learned',false),false);assert.equal(a.read('learned',false),false);}
});
test('lifecycle notification does not rerender the whole learning page on every keystroke',()=>{
  const s=store(),a=s.adapter('item','recall:1');let notifications=0;const unsubscribe=s.subscribe(()=>notifications++);
  a.write('answer','a');assert.equal(notifications,1,'notify once when input becomes dirty');a.write('answer','ab');assert.equal(notifications,1,'not on every keystroke');
  const ticket=a.begin();s.fail(ticket);assert.equal(notifications,3);unsubscribe();
});
test('live grading is tracked across navigation and cannot overlap another primary submission',async()=>{
  const s=store();let resolve;const result=new Promise(done=>resolve=done);
  assert.equal(typeof s.grade,'function');
  const pending=s.grade(()=>result);assert.equal(s.isPending(),true);assert.equal(s.isGrading(),true);
  assert.equal(s.adapter('other','quiz').begin(),null);
  resolve({correct:true});assert.deepEqual(await pending,{correct:true});assert.equal(s.isPending(),false);
});
test('disposing a page cancels the display scope of a delayed grading operation',async()=>{
  const s=store();let resolve;const pending=s.grade(()=>new Promise(done=>resolve=done));
  s.dispose();resolve(1);await pending;assert.equal(s.isPending(),false);
  await assert.rejects(s.grade(async()=>2));
});
test('draft identity ignores transport timestamps but changes with the actual content',()=>{
  const item={word:'cat',meaning:'猫',contentHash:'stable',updatedAt:'one'};
  assert.equal(learningDraftItemId('s','w',item),learningDraftItemId('s','w',{...item,updatedAt:'two'}));
  assert.notEqual(learningDraftItemId('s','w',item),learningDraftItemId('s','w',{...item,meaning:'不同释义'}));
  assert.notEqual(learningDraftItemId('s','w',item),learningDraftItemId('other','w',item));
});
test('legacy quiz code changes invalidate selected answers and the Python sandbox together',()=>{
  const item={topic:'Python',prompt:'What prints?',code:'print(1)',options:['1','2'],answer:'1'};
  assert.notEqual(learningDraftItemId('python','q',item),learningDraftItemId('python','q',{...item,code:'print(2)'}));
});
test('a presentation listener cannot prevent capture or a durable-success cleanup',()=>{
  const s=store();s.subscribe(()=>{throw new Error('presentation-only failure');});const a=s.adapter('item','quiz');a.write('answer','draft');
  const ticket=a.begin();assert.ok(ticket);assert.equal(s.commit(ticket),true);assert.equal(s.isPending(),false);
});
