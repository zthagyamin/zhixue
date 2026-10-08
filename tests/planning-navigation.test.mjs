import assert from 'node:assert/strict';
import test from 'node:test';
import {createPlanningNavigator,createTaskPlanController,SubjectPlanUnavailableError} from '../src/application/planning/index.ts';
import {generateTaskPlan,studyPracticeGroups,taskSourceHash,editTaskPlan,hashTaskPlan,emptySubjectRound} from '../src/domain/planning/index.ts';
import {createSubjectRoundSessions} from '../app/subject-round-resume.ts';
import {vocabularyInput} from './fixtures/task-plan-input.mjs';
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
async function fixture(overrides={}){
 const input=vocabularyInput(4),base=await generateTaskPlan(input),original=base.tasks[0];
 const tasks=original.action.itemKeys.map((key,index)=>({...original,taskId:'review-'+index,title:'复习 '+index,category:'review',reviewRoundId:'round-'+index,quantity:1,action:{kind:'practice',itemKeys:[key]}}));
 tasks.push({...original,taskId:'new-words'});for(const task of tasks)task.sourceHash=await taskSourceHash(task,input.catalog);
 const body={...base,tasks};delete body.planHash;const plan={...body,planHash:await hashTaskPlan(body)},stored=[],entries=[],rounds=createSubjectRoundSessions(),messages=[];
 const draft=createTaskPlanController({load:async()=>({plan,baseRevision:0,dirty:false}),save:async(_owner,value)=>stored.push(value),publish(){}});await draft.open('owner',plan.day);
 let epoch=0,mode='native',continuing=false;const source={ready:true,plan,catalog:input.catalog,libraryId:'library',completedTaskIds:[],startedTaskIds:[],pendingItemByTask:{},context:{}};
 const ports={begin:kind=>{if(kind==='continue'&&continuing)return null;const request=++epoch;return{scope:{owner:'owner',libraryId:'library',day:plan.day,mode},current:()=>request===epoch};},
  finish(){},canContinue:()=>!continuing,setContinuing:value=>{continuing=value;},prepareLeave:()=>()=>true,
  loadNative:async()=>source,loadAccount:async()=>source,groups:(value,eligible)=>studyPracticeGroups(value.plan,value.catalog,()=> 'recall',eligible),
  verify:async()=>{},persistStarted:(value,ids,current)=>draft.change(async old=>({...old,dirty:true,plan:await editTaskPlan(old.plan,{type:'start-group',taskIds:ids},value.catalog)}),current),
  groupItems:(_source,group)=>({keys:group.itemKeys,completedKeys:['word:0']}),
  getRound:rounds.get,activateRound:rounds.activate,enter:value=>entries.push(value),returnToday:()=>messages.push('today'),
  openNote:value=>messages.push(value),message:value=>messages.push(value),...overrides};
 return {navigator:createPlanningNavigator(ports),ports,source,stored,entries,messages,rounds,draft,cancel:()=>epoch++,account:()=>{mode='account';}};
}
test('native start locks the entire same-category group and resumes at its unfinished item',async()=>{
 const f=await fixture();await f.navigator.startNative('review-0');
 assert.deepEqual(f.stored[0].plan.manual.lockedTaskIds,['review-0','review-1','review-2','review-3']);
 assert.equal(f.entries.length,1);assert.equal(f.entries[0].index,1);assert.equal(f.entries[0].group.tasks.length,4);
 assert.deepEqual(f.source.plan.manual.lockedTaskIds,[]);
});
test('navigation cancelled during source verification cannot lock or open a group',async()=>{
 const gate=deferred(),entered=deferred(),f=await fixture({verify:async()=>{entered.resolve();await gate.promise;}});
 const pending=f.navigator.startNative('review-0');await entered.promise;f.cancel();gate.resolve();await pending;
 assert.equal(f.stored.length,0);assert.equal(f.entries.length,0);
});
test('the guarded persistence port prevents a queued start after navigation has changed',async()=>{
 const gate=deferred(),entered=deferred(),f=await fixture();const prior=f.draft.change(async value=>{entered.resolve();await gate.promise;return value;});await entered.promise;
 let queued;f.ports.persistStarted=(source,ids,current)=>{queued=true;return f.draft.change(async old=>({...old,plan:await editTaskPlan(old.plan,{type:'start-group',taskIds:ids},source.catalog)}),current);};
 const pending=f.navigator.startNative('review-0');for(let i=0;i<20&&!queued;i++)await new Promise(setImmediate);assert.equal(queued,true);
 f.cancel();gate.resolve();await prior;await pending;assert.equal(f.entries.length,0);assert.deepEqual(f.draft.snapshot().draft.plan.manual.lockedTaskIds,[]);
});
test('account entry never invokes native task-draft persistence and honors the resume key',async()=>{
 const f=await fixture();f.account();await f.navigator.startAccount({taskId:'review-0',resumeItemKey:'word:2'});
 assert.equal(f.stored.length,0);assert.equal(f.entries[0].index,2);assert.equal(f.entries[0].source.plan.planHash,f.source.plan.planHash);
});
test('continue uses page traversal only for navigation without changing formal completion',async()=>{
 const f=await fixture();await f.navigator.startNative('review-0');const entry=f.entries[0];
 f.rounds.set({vocab:{...emptySubjectRound(),reviewedKeys:entry.group.itemKeys}});
 await f.navigator.continueToday();assert.equal(f.entries.at(-1).task.taskId,'new-words');assert.deepEqual(f.source.completedTaskIds,[]);
});
test('a second leave confirmation can prevent display without discarding the accepted task lock',async()=>{
 const f=await fixture({prepareLeave:()=>()=>false});await f.navigator.startNative('review-0');
 assert.equal(f.stored.length,1);assert.equal(f.entries.length,0);
});

for(const mode of ['three-stage','spelling','flashcard','recall','quiz','calculation','code','paper'])test(`${mode}: subject entry resumes the entire same-mode group, not its first task`,async()=>{
 const f=await fixture({groups:(source,ids)=>studyPracticeGroups(source.plan,source.catalog,()=>mode,ids)});
 f.source.completedTaskIds=['review-0'];f.source.startedTaskIds=['review-1'];
 await f.navigator.startSubject('vocab');
 assert.equal(f.entries.length,1);assert.equal(f.entries[0].task.taskId,'review-1');
 assert.deepEqual(f.entries[0].group.itemKeys,['word:0','word:1','word:2','word:3']);
 assert.equal(f.entries[0].index,1);assert.deepEqual(f.source.completedTaskIds,['review-0']);
});

test('account subject entry uses the same grouping and never writes native task state',async()=>{
 const f=await fixture();f.account();f.source.pendingItemByTask={'review-0':'word:2'};
 await f.navigator.startSubject('vocab');assert.equal(f.entries[0].group.tasks.length,4);assert.equal(f.entries[0].index,2);assert.equal(f.stored.length,0);
});

test('subject navigation preserves an explicit review target and cannot expand the day silently',async()=>{
 const f=await fixture();f.source.plan.tasks=f.source.plan.tasks.filter(task=>task.category==='review');
 f.source.plan.longTermAllocation={reviewTarget:2};await f.navigator.startSubject('vocab');
 assert.deepEqual(f.entries[0].group.itemKeys,['word:0','word:1']);
});

test('subject without daily tasks opens free study without recording an attempt',async()=>{
 const opened=[],f=await fixture({openSubject:(...args)=>opened.push(args)});
 await f.navigator.startSubject('unplanned');assert.deepEqual(opened,[['unplanned',true]]);assert.equal(f.entries.length,0);assert.equal(f.stored.length,0);
});

test('cancelled subject navigation cannot fall back into the old subject',async()=>{
 const gate=deferred(),opened=[],f=await fixture({loadNative:async()=>{await gate.promise;return null;},openSubject:(...args)=>opened.push(args)});
 const pending=f.navigator.startSubject('vocab');f.cancel();gate.resolve();await pending;
 assert.deepEqual(opened,[]);assert.equal(f.entries.length,0);
});

test('all-completed subject reopens its whole group recap instead of a single completed word',async()=>{
 const f=await fixture();f.source.plan.tasks=f.source.plan.tasks.filter(task=>task.category==='review');
 f.source.completedTaskIds=f.source.plan.tasks.map(task=>task.taskId);await f.navigator.startSubject('vocab');
 assert.equal(f.entries[0].group.itemKeys.length,4);
});

test('blocked planned content cannot bypass validation through a free-study fallback',async()=>{
 const opened=[],f=await fixture({openSubject:(...args)=>opened.push(args)});
 for(const task of f.source.plan.tasks)task.blockedReason='source changed';
 await f.navigator.startSubject('vocab');assert.equal(f.entries.length,0);assert.deepEqual(opened,[]);assert.match(f.messages[0],/待核对/);
});

test('subject navigation keeps different plugin modes and new/review categories apart',async()=>{
 const f=await fixture({groups:(source,ids)=>studyPracticeGroups(source.plan,source.catalog,key=>key==='word:2'?'flashcard':'three-stage',ids)});
 await f.navigator.startSubject('vocab');assert.deepEqual(f.entries[0].group.itemKeys,['word:0','word:1','word:3']);
 assert.ok(f.entries[0].group.tasks.every(task=>task.category==='review'));
});

for(const blocked of [false,true])test(`deferred subject cannot silently enter free study (blocked=${blocked})`,async()=>{
 const opened=[],f=await fixture({openSubject:(...args)=>opened.push(args)});
 f.source.plan.tasks=f.source.plan.tasks.filter(task=>task.category==='review');f.source.plan.longTermAllocation={reviewTarget:0};
 if(blocked)for(const task of f.source.plan.tasks)task.blockedReason='source changed';
 await f.navigator.startSubject('vocab');assert.deepEqual(opened,[]);assert.equal(f.entries.length,0);assert.equal(f.stored.length,0);
 assert.match(f.messages[0],blocked?/待核对/:/追加复习/);
});

test('unavailable subject plan opens recovery without silently enabling free study',async()=>{
 const opened=[],f=await fixture({loadSubject:async()=>{throw new SubjectPlanUnavailableError('offline');},openSubject:(...args)=>opened.push(args)});
 f.account();await f.navigator.startSubject('vocab');assert.deepEqual(opened,[['vocab',false]]);assert.equal(f.entries.length,0);assert.equal(f.stored.length,0);
});

test('verified subject snapshot can start without a new account plan network request',async()=>{
 const f=await fixture({loadAccount:async()=>assert.fail('must reuse verified subject source')});
 f.ports.loadSubject=async()=>f.source;f.account();await f.navigator.startSubject('vocab');assert.equal(f.entries[0].group.itemKeys.length,4);
});

test('default review target fills from available questions, not withheld materials',async()=>{
 const f=await fixture({groups:(source,ids)=>studyPracticeGroups(source.plan,source.catalog,()=> 'recall',(ids??source.plan.tasks.map(t=>t.taskId)).filter(id=>id!=='review-0'))});
 f.source.plan.tasks=f.source.plan.tasks.filter(t=>t.category==='review');f.source.plan.longTermAllocation={reviewTarget:2};
 await f.navigator.startSubject('vocab');assert.deepEqual(f.entries[0].group.itemKeys,['word:1','word:2']);
 assert.deepEqual(f.source.completedTaskIds,[]);
});

for(const mode of ['native','account'])test(`${mode}: budget applies to actual navigation and automatic cache cannot retain all tasks`,async()=>{
 const f=await fixture();if(mode==='account')f.account();
 f.source.plan.longTermAllocation={reviewTarget:4,practiceBudgetGroups:[{id:'g',title:'shared',subjectIds:['vocab'],minutes:3,defaultItemMinutes:3}]};
 for(const task of f.source.plan.tasks)delete task.estimatedMinutes;
 await f.navigator.startSubject('vocab');assert.deepEqual(f.entries[0].group.tasks.map(t=>t.taskId),['review-0']);assert.deepEqual(f.entries[0].selection.taskIds,[]);
 f.source.selection=f.entries[0].selection;f.source.completedTaskIds=['review-0'];
 await f.navigator.continueToday();assert.equal(f.entries.at(-1).task.taskId,'new-words');assert.deepEqual(f.source.completedTaskIds,['review-0']);
});
for(const mode of ['native','account'])test(`${mode}: stale eligible IDs cannot bypass zero budget; explicit scoped addition can`,async()=>{
 const f=await fixture();if(mode==='account')f.account();
 f.source.plan.longTermAllocation={practiceBudgetGroups:[{id:'g',title:'shared',subjectIds:['vocab'],minutes:0,defaultItemMinutes:3}]};
 const start=()=>mode==='account'?f.navigator.startAccount({taskId:'review-0',eligibleTaskIds:['review-0']}):f.navigator.startNative('review-0',['review-0']);
 await start();assert.equal(f.entries.length,0);assert.match(f.messages[0],/不在当前分组/);
 const {practiceSelectionScope}=await import('../src/domain/planning/index.ts');
 f.source.selection={scope:practiceSelectionScope('owner','library',f.source.plan),taskIds:['review-0']};await start();assert.equal(f.entries.length,1);
 f.source.plan.sourceHash='changed';await start();assert.equal(f.entries.length,1);
});
test('budget counts distinct physical review rounds without borrowing older completion',async()=>{
 const f=await fixture();const first=f.source.plan.tasks[0];f.source.plan.tasks=[first,{...first,taskId:'later',reviewRoundId:'later-round'}];
 f.source.completedTaskIds=[first.taskId];f.source.plan.longTermAllocation={practiceBudgetGroups:[{id:'g',title:'shared',subjectIds:['vocab'],minutes:3,defaultItemMinutes:3}]};
 for(const task of f.source.plan.tasks)delete task.estimatedMinutes;
 await f.navigator.continueToday();assert.equal(f.entries.length,0);assert.deepEqual(f.source.completedTaskIds,[first.taskId]);
});
