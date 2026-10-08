import test from 'node:test';
import assert from 'node:assert/strict';
import {createGuidanceStore,guidanceKey} from '../app/study-guidance-state.ts';
import {guidanceKind,guidanceTip,STUDY_GUIDES} from '../app/study-guidance-content.ts';
import {saveStatusPresentation} from '../app/study-save-status-model.ts';

function fixture(){
 const values=new Map(),writes=[],reads=[];
 const storage={getItem(key){reads.push(key);return values.get(key)??null;},setItem(key,value){writes.push([key,value]);values.set(key,value);}};
 return {values,writes,reads,storage,store:createGuidanceStore(()=>storage)};
}
function load(store,scope='owner-a',topic='three-stage-1'){return store.subscribe(scope,topic,()=>{});}

test('opening a new exercise does not mark its tutorial as read',()=>{
 const f=fixture();assert.equal(f.store.snapshot('owner-a','three-stage-1'),'unknown');
 const stop=load(f.store);assert.equal(f.store.snapshot('owner-a','three-stage-1'),'first');assert.deepEqual(f.writes,[]);stop();
});
test('acknowledgement persists only one UI marker and is idempotent',()=>{
 const f=fixture();load(f.store);f.store.acknowledge('owner-a','three-stage-1');f.store.acknowledge('owner-a','three-stage-1');
 assert.equal(f.store.snapshot('owner-a','three-stage-1'),'seen');assert.deepEqual(f.writes,[[guidanceKey('owner-a','three-stage-1'),'1']]);
});
test('a fresh store after reload reads the acknowledged topic',()=>{
 const f=fixture();load(f.store);f.store.acknowledge('owner-a','three-stage-1');const fresh=createGuidanceStore(()=>f.storage);load(fresh);
 assert.equal(fresh.snapshot('owner-a','three-stage-1'),'seen');
});
test('changing cards and subjects reuses the same owner and practice-topic marker',()=>{
 const f=fixture();const stop=load(f.store);f.store.acknowledge('owner-a','quiz');stop();load(f.store,'owner-a','quiz');
 assert.equal(f.store.snapshot('owner-a','quiz'),'seen');assert.equal(f.writes.length,1);
});
test('separate practice modes and genuinely new stages are independent',()=>{
 const f=fixture();f.store.acknowledge('owner-a','three-stage-1');
 for(const topic of ['three-stage-2','three-stage-3','quiz','code','paper']){load(f.store,'owner-a',topic);assert.equal(f.store.snapshot('owner-a',topic),'first');}
});
test('one account cannot suppress another account tutorial',()=>{
 const f=fixture();f.store.acknowledge('owner-a','quiz');load(f.store,'owner-b','quiz');assert.equal(f.store.snapshot('owner-b','quiz'),'first');
});
test('anonymous contexts use memory only, not saved preferences of another identity',()=>{
 const f=fixture();f.store.subscribe(undefined,'quiz',()=>{});f.store.acknowledge(undefined,'quiz');
 assert.equal(f.store.snapshot(undefined,'quiz'),'seen');assert.equal(f.reads.length,0);assert.equal(f.writes.length,0);
});
test('blocked storage access still permits dismissal for this page lifetime',()=>{
 const store=createGuidanceStore(()=>{throw new Error('blocked getter');});load(store);store.acknowledge('owner-a','three-stage-1');load(store);assert.equal(store.snapshot('owner-a','three-stage-1'),'seen');
});
test('failed writes do not cause repeated hints when moving to the next card',()=>{
 const store=createGuidanceStore(()=>({getItem:()=>null,setItem(){throw new Error('quota');}}));const stop=load(store);store.acknowledge('owner-a','three-stage-1');stop();load(store);assert.equal(store.snapshot('owner-a','three-stage-1'),'seen');
});
test('only the exact stored read marker counts as an acknowledgement',()=>{
 for(const value of ['true','0','null','{}','',null]){const f=fixture();f.values.set(guidanceKey('owner-a','quiz'),value);load(f.store,'owner-a','quiz');assert.equal(f.store.snapshot('owner-a','quiz'),'first');}
});
test('cross-tab acknowledgement affects only its own scope and mode',()=>{
 const f=fixture();load(f.store,'owner-a','quiz');load(f.store,'owner-b','quiz');load(f.store,'owner-a','code');
 f.store.receiveStorage(guidanceKey('owner-a','quiz'),'1');assert.equal(f.store.snapshot('owner-a','quiz'),'seen');assert.equal(f.store.snapshot('owner-b','quiz'),'first');assert.equal(f.store.snapshot('owner-a','code'),'first');assert.deepEqual(f.writes,[]);
});
test('unrelated storage and storage clearing never reopen a just-dismissed hint mid-session',()=>{
 const f=fixture();load(f.store);f.store.acknowledge('owner-a','three-stage-1');
 for(const [key,value] of [[null,null],['other','1'],[guidanceKey('owner-a','three-stage-1'),null],[guidanceKey('owner-a','three-stage-1'),'0']])f.store.receiveStorage(key,value);
 assert.equal(f.store.snapshot('owner-a','three-stage-1'),'seen');
});
test('subscribers get primitive stable snapshots and unsubscribe cleanly',()=>{
 const f=fixture();let calls=0;const stop=f.store.subscribe('owner-a','quiz',()=>calls++);assert.equal(calls,1);
 const before=f.store.snapshot('owner-a','quiz');assert.equal(before,f.store.snapshot('owner-a','quiz'));
 f.store.acknowledge('owner-a','quiz');assert.equal(calls,2);stop();f.store.receiveStorage(guidanceKey('owner-a','code'),'1');assert.equal(calls,2);
});
test('punctuation in owner identifiers cannot collide',()=>{
 assert.notEqual(guidanceKey('a:b','quiz'),guidanceKey('a%3Ab','quiz'));assert.notEqual(guidanceKey(undefined,'quiz'),guidanceKey('null','quiz'));
});
test('each supported learning plugin has complete manually accessible instructions',()=>{
 for(const kind of ['three-stage','flashcard','spelling','quiz','recall','calculation','code','paper']){assert.equal(guidanceKind('@zhixue/plugin-'+kind),kind);assert.ok(guidanceTip(kind));assert.ok(STUDY_GUIDES[kind].details.length>=2);}
});
test('different word phases use short task-specific instructions',()=>{
 assert.match(guidanceTip('three-stage-1'),/回想词义/);assert.match(guidanceTip('three-stage-2'),/例句/);assert.match(guidanceTip('three-stage-3'),/不看提示/);
});
test('unknown or inherited plugin names do not resolve to a help document',()=>{
 for(const name of [undefined,'constructor','__proto__','made-up'])assert.equal(guidanceKind(name),null);
});
test('help retains grading consequences rather than claiming mastery from viewing answers',()=>{
 assert.match(STUDY_GUIDES['three-stage'].details.join(' '),/不等于.*掌握/);
 assert.match(STUDY_GUIDES['three-stage'].details.join(' '),/需要复习记录/);
 assert.match(STUDY_GUIDES.recall.details.join(' '),/结构提示.*困难/);
 assert.match(STUDY_GUIDES.calculation.details.join(' '),/不会重复记分/);
});
test('confirmed auxiliary writeback uses a quiet local-save summary, not an all-devices claim',()=>{
 const state=saveStatusPresentation('applied');assert.equal(state.attention,false);assert.match(state.label,/本机/);assert.doesNotMatch(state.label,/所有|全部|已同步/);
});
test('normal in-flight auxiliary receipts remain readable without an error banner',()=>{
 for(const key of ['pending','parent-pending','account-received','received']){const state=saveStatusPresentation(key);assert.equal(state.attention,false);assert.match(state.label,/待同步/);}
});
test('failed, blocked and unsupported auxiliary states always remain attention-visible',()=>{
 for(const key of ['not-saved','blocked','binding-unknown','unsupported','unknown','unexpected'])assert.equal(saveStatusPresentation(key).attention,true,key);
});
