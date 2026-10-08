import assert from 'node:assert/strict';
import test from 'node:test';
import {catalog,DAY,baseline,attempt} from './fixtures/task-event-fixtures.mjs';
import {courseSubject} from './fixtures/task-plan-input.mjs';
import {generateTaskPlan} from '../app/task-plan-engine.ts';
import {vocabularyInput} from './fixtures/task-plan-input.mjs';
import {hashTaskPlan} from '../app/task-plan-engine.ts';
import {loadTaskDraft,saveTaskDraft,archiveTaskDraft,loadTaskDraftBackups,parseTaskDraft} from '../app/local-task-plan.ts';
import {IDBFactory,IDBKeyRange} from 'fake-indexeddb';
import {putLocalStudyEvent,listWorkspaceStudyEvents} from '../app/local-study-events.ts';
import {replayReviewEvents} from '../app/review-projection.ts';
let api;
try {api=await import('../app/task-planning-session.ts');} catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND') throw error;}
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {promise,resolve};};
async function fixture(changes={}) {
  assert.equal(typeof api?.createTaskPlanningSession,'function','Planning session must connect persisted drafts to complete facts');
  const data=catalog(),subject=courseSubject(1);subject.goals=[];data.subjects.push(subject);
  const bundle={context:{catalog:data,sourceReviews:[],captureReviews:[],observedAt:'2026-08-31T05:00:00.000Z',planRevision:0,capabilities:['task-planning-v1']},
    localEvents:[],companionRecords:[],taskEvents:[],legacyItemKeys:[],history:{local:'complete',cloud:'not-applicable',companion:'complete',tasks:'complete'},
    authority:{revision:0,candidate:null,history:[]}};
  const saved=[],reports=[],suggestions=[],snapshots=[],backups=[];
  const session=api.createTaskPlanningSession({loadDraft:async()=>null,saveDraft:async(_workspace,draft)=>saved.push(structuredClone(draft)),
    loadBundle:async()=>structuredClone(bundle),putTaskEvent:async(_workspace,event)=>reports.push(event),now:()=>new Date('2026-08-31T06:00:00.000Z'),
    client:{suggestPlan:async input=>{suggestions.push(input);return {...input,mode:'fallback',selections:[],message:'AI 未配置，规则任务保留。'};},
      applyTaskPlan:async plan=>({status:'ok',revision:{revision:1,after:plan}})},archiveDraft:async(_workspace,draft)=>backups.push(structuredClone(draft)),publish:state=>snapshots.push(state),...changes});
  await session.open('fixture-workspace',DAY);
  return {session,bundle,saved,reports,suggestions,snapshots,backups};
}
test('opening complete facts does not generate a plan or call AI by itself',async()=>{
  const {session,suggestions,saved}=await fixture();assert.equal(session.snapshot().ready,true);assert.equal(session.snapshot().draft,null);
  assert.equal(suggestions.length,0);assert.equal(saved.length,0);
});
test('ordinary evidence refresh retains unstarted AI suggestions without requesting new suggestions',async()=>{
  let calls=0;
  const {session}=await fixture({client:{suggestPlan:async request=>{calls++;return {...request,mode:'fallback',selections:[{unitIds:['course:u0'],reason:'next'}],message:''};}}});
  await session.generate();const task=session.snapshot().draft.plan.tasks.find(task=>task.origin==='fallback');assert.ok(task);
  await session.refresh();assert.ok(session.snapshot().draft.plan.tasks.some(item=>item.taskId===task.taskId));assert.equal(calls,1);
});
test('an unchanged saved plan remains clean and ordered after a normal refresh',async()=>{
  const {session,bundle}=await fixture({client:{suggestPlan:async request=>({...request,mode:'fallback',selections:[{unitIds:['course:u0'],reason:'next'}],message:''}),
    applyTaskPlan:async plan=>({status:'ok',revision:{revision:1,after:plan}})}});
  await session.generate();await session.save();
  const original=session.snapshot().draft;assert.equal(original.dirty,false);
  bundle.authority={revision:1,candidate:original.plan,history:[]};bundle.context.planRevision=1;
  await session.refresh();
  assert.equal(session.snapshot().draft.dirty,false);assert.deepEqual(session.snapshot().draft.plan.tasks,original.plan.tasks);
});
test('offline verified facts preserve local plans and block AI or authority writes without deleting suggestions',async()=>{
  const {session,bundle,suggestions}=await fixture();await session.generate();await session.save();
  const original=session.snapshot().draft;bundle.offline=true;
  await session.refresh();assert.equal(session.snapshot().offline,true);assert.equal(session.snapshot().ready,true);
  assert.equal(session.snapshot().draft.baseRevision,original.baseRevision);assert.equal(session.snapshot().lastSyncedAt,bundle.context.observedAt);
  const hash=session.snapshot().draft.plan.planHash,calls=suggestions.length;
  await assert.rejects(session.suggest('standard'),/离线/);await assert.rejects(session.save(),/离线/);
  assert.equal(session.snapshot().draft.plan.planHash,hash);assert.equal(suggestions.length,calls);
});
test('reconnection adopts the saved arrangement and preserves the offline draft automatically',async()=>{
  const {session,bundle,backups}=await fixture();await session.generate();bundle.offline=true;await session.refresh();
  const local=session.snapshot().draft;
  bundle.offline=false;bundle.authority.revision=2;bundle.context.planRevision=2;
  await session.refresh();assert.equal(session.snapshot().offline,false);assert.equal(session.snapshot().conflict,null);
  assert.equal(session.snapshot().ready,true);assert.equal(session.snapshot().draft.baseRevision,2);assert.deepEqual(backups,[local]);
});
test('remote replacement rechecks a manual edit that finished while replacement was queued',async()=>{
  const input=vocabularyInput(0);input.catalog.subjects.push(courseSubject(1));const plan=await generateTaskPlan(input);
  const saved=deferred(),release=deferred(),fetched=deferred();let first=true,revision=1,candidate=null;
  const {session,backups}=await fixture({loadDraft:async()=>({plan,baseRevision:1,dirty:false}),saveDraft:async()=>{
    if(first){first=false;saved.resolve();await release.promise;}
  },loadBundle:async()=>{if(revision===2) fetched.resolve();return {context:{catalog:input.catalog,sourceReviews:[],captureReviews:[],observedAt:'2026-08-31T05:00:00.000Z',planRevision:revision,capabilities:[]},
    localEvents:[],companionRecords:[],taskEvents:[],legacyItemKeys:[],history:{local:'complete',cloud:'not-applicable',companion:'complete',tasks:'complete'},authority:{revision,candidate,history:[]}};}});
  const current=session.snapshot().draft.plan.tasks[0];
  const editing=session.edit({type:'upsert',task:{...current,title:'My new manual title'}});await saved.promise;
  // The newer remote plan is fetched while the old clean draft is still visible.
  revision=2;candidate=plan;
  const originalRefresh=session.refresh();
  await fetched.promise;await new Promise(resolve=>setImmediate(resolve));release.resolve();await editing;
  await originalRefresh;
  assert.equal(backups[0].plan.tasks[0].title,'My new manual title');
  assert.equal(session.snapshot().draft.plan.tasks[0].title,plan.tasks[0].title);assert.equal(session.snapshot().draft.dirty,false);
});
test('generation persists mandatory tasks before requesting AI and an AI failure cannot erase them',async()=>{
  const waiting=deferred(),entered=deferred(),{session,saved}=await fixture({client:{suggestPlan:()=>{entered.resolve();return waiting.promise;}}});
  const pending=session.generate();await entered.promise;
  assert.ok(saved.length>0);assert.ok(saved[0].plan.tasks.some(task=>task.category==='new-word' && task.required));
  waiting.resolve({...session.snapshot().draft.plan,mode:'fallback',selections:[],message:'AI 未配置'});await pending;
  assert.ok(session.snapshot().draft.dirty);assert.match(session.snapshot().message,/AI 未配置/);
});
test('failed full refresh keeps the saved draft readable but does not claim history ready',async()=>{
  let fail=false;const {session}=await fixture({loadBundle:async()=>{
    if(fail) throw new Error('history offline');
    const c=catalog();return {context:{catalog:c,sourceReviews:[],captureReviews:[],observedAt:'2026-08-31T05:00:00.000Z',planRevision:0,capabilities:[]},localEvents:[],companionRecords:[],taskEvents:[],legacyItemKeys:[],history:{local:'complete',cloud:'not-applicable',companion:'complete',tasks:'complete'},authority:{revision:0,candidate:null,history:[]}};
  }});
  await session.generate();const hash=session.snapshot().draft.plan.planHash;fail=true;
  await assert.rejects(session.refresh(),/history offline/);
  assert.equal(session.snapshot().draft.plan.planHash,hash);assert.equal(session.snapshot().ready,false);
});
test('a revision conflict leaves the local dirty plan intact',async()=>{
  const {session}=await fixture({client:{suggestPlan:async request=>({...request,mode:'fallback',selections:[],message:''}),applyTaskPlan:async()=>({status:'stale',message:'revision changed'})}});
  await session.generate();const hash=session.snapshot().draft.plan.planHash;
  await assert.rejects(session.save(),/revision changed/);
  assert.equal(session.snapshot().draft.plan.planHash,hash);assert.equal(session.snapshot().draft.dirty,true);
});
test('ordinary refresh archives unsaved edits and adopts the remote plan without an authority write',async()=>{
  const {session,bundle,backups}=await fixture();await session.generate();
  const before=session.snapshot().draft;bundle.authority={revision:2,candidate:before.plan,history:[]};bundle.context.planRevision=2;
  const task={taskId:'manual:local',subjectId:'course',title:'Local only',category:'subject',origin:'manual',required:false,unitIds:[],quantity:1,action:{kind:'manual'},completionRule:'self-report',sourceHash:bundle.context.catalog.sourceHash};
  await session.edit({type:'upsert',task});const localPlan=session.snapshot().draft.plan;
  await session.refresh();assert.equal(session.snapshot().conflict,null);assert.equal(session.snapshot().ready,true);
  assert.equal(backups[0].plan.planHash,localPlan.planHash);assert.equal(session.snapshot().draft.baseRevision,2);
  assert.ok(!session.snapshot().draft.plan.tasks.some(task=>task.taskId==='manual:local'));
  await session.restoreLastBackup();assert.ok(session.snapshot().draft.plan.tasks.some(task=>task.taskId==='manual:local'));
});
test('restoring a low-version backup advances past the current high-version draft using real atomic storage',async()=>{
  globalThis.indexedDB=new IDBFactory();
  const {session,bundle}=await fixture({loadDraft:loadTaskDraft,saveDraft:saveTaskDraft,archiveDraft:archiveTaskDraft});await session.generate();
  const body={...session.snapshot().draft.plan,draftVersion:100};delete body.planHash;
  const remote={...body,planHash:await hashTaskPlan(body)};
  const task={taskId:'manual:restore',subjectId:'course',title:'Recover this',category:'subject',origin:'manual',required:false,unitIds:[],quantity:1,action:{kind:'manual'},completionRule:'self-report',sourceHash:bundle.context.catalog.sourceHash};
  await session.edit({type:'upsert',task});bundle.authority={revision:2,candidate:remote,history:[]};bundle.context.planRevision=2;
  await session.refresh();assert.equal(session.snapshot().draft.plan.draftVersion,100);
  await session.restoreLastBackup();assert.ok(session.snapshot().draft.plan.draftVersion>100);assert.ok(session.snapshot().draft.plan.tasks.some(task=>task.taskId==='manual:restore'));
});
test('failed automatic backup prevents replacing the recoverable local draft',async()=>{
  const {session,bundle}=await fixture({archiveDraft:async()=>{throw new Error('backup failed');}});await session.generate();
  const before=session.snapshot().draft;bundle.authority.revision=2;bundle.context.planRevision=2;
  await assert.rejects(session.refresh(),/backup failed/);assert.equal(session.snapshot().ready,false);
  assert.equal(session.snapshot().draft.plan.planHash,before.plan.planHash);assert.equal(session.snapshot().draft.baseRevision,before.baseRevision);
});
test('a remote revision changing during adoption keeps the draft and a retry adopts the new revision',async()=>{
  const initial=await fixture();let reads=0,change=false;
  const {session,backups}=await fixture({loadBundle:async()=>{
    const fetched=structuredClone(initial.bundle);if(change){fetched.authority.revision=++reads===1?2:3;fetched.context.planRevision=fetched.authority.revision;}return fetched;
  }});await session.generate();const original=session.snapshot().draft;change=true;
  await assert.rejects(session.refresh(),/再次|变化/);assert.equal(backups.length,0);assert.deepEqual(session.snapshot().draft,original);
  await session.refresh();assert.equal(session.snapshot().draft.baseRevision,3);assert.equal(session.snapshot().ready,true);assert.deepEqual(backups,[original]);
});

test('an older saved revision cannot roll back a dirty draft or create a backup',async()=>{
  const {session,bundle,backups}=await fixture();await session.generate();await session.save();await session.optionalMinutes(12);
  const before=session.snapshot().draft;bundle.authority.revision=0;bundle.context.planRevision=0;
  await assert.rejects(session.refresh(),/较旧/);assert.deepEqual(session.snapshot().draft,before);assert.equal(backups.length,0);
});

test('a superseded read cannot finish automatic adoption after a newer refresh starts',async()=>{
  const archived=deferred(),release=deferred();let block=true;
  const {session,bundle}=await fixture({archiveDraft:async()=>{if(block){block=false;archived.resolve();await release.promise;}}});await session.generate();
  bundle.authority.revision=2;bundle.context.planRevision=2;
  const old=session.refresh();await archived.promise;
  bundle.authority.revision=3;bundle.context.planRevision=3;
  const newest=session.refresh();await new Promise(resolve=>setImmediate(resolve));release.resolve();await Promise.all([old,newest]);
  assert.equal(session.snapshot().draft.baseRevision,3);assert.equal(session.snapshot().ready,true);assert.equal(session.snapshot().conflict,null);
});

test('a superseded in-flight save cannot replace the original unsaved recovery point with a clean intermediate plan',async()=>{
  globalThis.indexedDB=new IDBFactory();const writing=deferred(),release=deferred();let armed=false;
  const {session,bundle}=await fixture({loadDraft:loadTaskDraft,archiveDraft:archiveTaskDraft,saveDraft:async(...args)=>{
    if(armed&&args[1].baseRevision===2){armed=false;writing.resolve();await release.promise;}await saveTaskDraft(...args);
  }});await session.generate();await session.optionalMinutes(7);const original=session.snapshot().draft;
  const makeRemote=async(optionalMinutes,draftVersion)=>{const body={...original.plan,optionalMinutes,draftVersion};delete body.planHash;return {...body,planHash:await hashTaskPlan(body)};};
  bundle.authority={revision:2,candidate:await makeRemote(10,100),history:[]};bundle.context.planRevision=2;armed=true;
  const first=session.refresh();await writing.promise;
  bundle.authority={revision:3,candidate:await makeRemote(20,101),history:[]};bundle.context.planRevision=3;
  const second=session.refresh();await new Promise(resolve=>setImmediate(resolve));release.resolve();await Promise.all([first,second]);
  assert.equal(session.snapshot().draft.plan.optionalMinutes,20);assert.deepEqual(session.snapshot().lastBackup,original);
  assert.deepEqual((await loadTaskDraftBackups('fixture-workspace',DAY)).at(-1).draft,original);
  await session.restoreLastBackup();assert.equal(session.snapshot().draft.plan.optionalMinutes,7);
});

test('switching workspaces during backup cannot install the former workspace plan',async()=>{
  const archived=deferred(),release=deferred();let block=true;
  const {session,bundle}=await fixture({archiveDraft:async()=>{if(block){block=false;archived.resolve();await release.promise;}}});await session.generate();
  bundle.authority.revision=2;bundle.context.planRevision=2;
  const old=session.refresh();await archived.promise;
  const next=session.open('other-workspace',DAY);await new Promise(resolve=>setImmediate(resolve));release.resolve();await Promise.all([old,next]);
  assert.equal(session.snapshot().workspaceId,'other-workspace');assert.equal(session.snapshot().draft,null);assert.equal(session.snapshot().lastBackup,null);
});

test('legacy IndexedDB drafts and backups survive automatic adoption, reopening and restoration',async()=>{
  globalThis.indexedDB=new IDBFactory();let authorityWrites=0;
  const storage={loadDraft:loadTaskDraft,saveDraft:saveTaskDraft,archiveDraft:archiveTaskDraft,loadLastBackup:async(workspace,day)=>(await loadTaskDraftBackups(workspace,day)).at(-1)?.draft??null,
    client:{suggestPlan:async request=>({...request,mode:'fallback',selections:[],message:''}),applyTaskPlan:async()=>{authorityWrites++;throw new Error('unexpected authority write');}}};
  const {session,bundle}=await fixture(storage);await session.generate();await session.optionalMinutes(17);
  const legacy=session.snapshot().draft;
  const body={...legacy.plan,optionalMinutes:30,draftVersion:100};delete body.planHash;
  bundle.authority={revision:2,candidate:{...body,planHash:await hashTaskPlan(body)},history:[]};bundle.context.planRevision=2;
  await session.refresh();const synced=await loadTaskDraft('fixture-workspace',DAY);
  assert.equal(synced.plan.optionalMinutes,30);assert.deepEqual((await loadTaskDraftBackups('fixture-workspace',DAY))[0].draft,legacy);
  const reopened=await fixture({...storage,loadBundle:async()=>structuredClone(bundle)});
  assert.deepEqual(reopened.session.snapshot().lastBackup,legacy);await reopened.session.restoreLastBackup();
  const restored=await loadTaskDraft('fixture-workspace',DAY);assert.equal(restored.plan.optionalMinutes,17);assert.equal(restored.dirty,true);assert.ok(restored.plan.draftVersion>100);
  assert.deepEqual(parseTaskDraft(restored),restored);assert.deepEqual(parseTaskDraft(synced),synced);
  assert.equal(authorityWrites,0);
});

test('draft adoption and rollback retain every legacy fact, delivery status and FSRS projection',async()=>{
  globalThis.indexedDB=new IDBFactory();globalThis.IDBKeyRange=IDBKeyRange;
  const events=[await baseline(),await attempt('migration-review','2026-08-31T02:00:00Z',2,3)],workspace='fixture-workspace';
  for(const event of events)await putLocalStudyEvent({workspaceId:workspace,eventId:event.eventId,event,cloud:'pending',companion:'acked',occurredAt:event.occurredAt,updatedAt:event.occurredAt});
  const recordsBefore=await listWorkspaceStudyEvents(workspace),projectionBefore=await replayReviewEvents(events),{bundle}=await fixture();
  const storage={loadDraft:loadTaskDraft,saveDraft:saveTaskDraft,archiveDraft:archiveTaskDraft,
    loadBundle:async()=>({...structuredClone(bundle),localEvents:(await listWorkspaceStudyEvents(workspace)).map(record=>record.event)}),
    loadLastBackup:async(id,day)=>(await loadTaskDraftBackups(id,day)).at(-1)?.draft??null};
  const {session}=await fixture(storage);await session.generate();await session.optionalMinutes(11);
  const original=session.snapshot().draft,body={...original.plan,optionalMinutes:22,draftVersion:100};delete body.planHash;
  bundle.authority={revision:2,candidate:{...body,planHash:await hashTaskPlan(body)},history:[]};bundle.context.planRevision=2;
  await session.refresh();assert.equal(session.snapshot().draft.plan.optionalMinutes,22);
  const reopened=await fixture(storage);await reopened.session.restoreLastBackup();assert.equal(reopened.session.snapshot().draft.plan.optionalMinutes,11);
  const after=await listWorkspaceStudyEvents(workspace);
  assert.deepEqual(after,recordsBefore);assert.deepEqual(await replayReviewEvents(after.map(record=>record.event)),projectionBefore);
  // These unversioned record shapes are the same ones understood by the preceding release.
  for(const backup of await loadTaskDraftBackups(workspace,DAY))assert.deepEqual(parseTaskDraft(backup.draft),backup.draft);
});
test('new evidence immediately invalidates a pending suggestion without canceling an in-flight history load',async()=>{
  const waiting=deferred(),entered=deferred(),{session,saved}=await fixture({client:{suggestPlan:()=>{entered.resolve();return waiting.promise;}}});
  assert.equal(typeof session.evidenceChanged,'function');
  const pending=session.generate();await entered.promise;const before=session.snapshot().draft;
  session.evidenceChanged();waiting.resolve({...before.plan,mode:'fallback',selections:[],message:'old suggestion'});await pending;
  assert.equal(saved.length,1);assert.equal(session.snapshot().ready,false);assert.notEqual(session.snapshot().message,'old suggestion');
});
test('task completion is persisted before the UI can show a self-report checkmark',async()=>{
  const {session,reports}=await fixture();await session.generate();
  const task={taskId:'manual:test',subjectId:'course',title:'Read notes',category:'subject',origin:'manual',required:false,unitIds:[],quantity:1,action:{kind:'manual'},completionRule:'self-report',sourceHash:catalog().sourceHash};
  await session.edit({type:'upsert',task});await session.complete(task.taskId);
  assert.equal(reports.length,1);assert.equal(reports[0].source,'self-report');assert.ok(session.snapshot().completedTaskIds.includes(task.taskId));
});
test('late workspace fact loads cannot replace the current workspace',async()=>{
  const waiting=deferred(),{bundle}=await fixture();
  const second=await fixture({loadBundle:async workspace=>workspace==='slow'?waiting.promise:structuredClone(bundle)});
  const pending=second.session.open('slow',DAY);await new Promise(resolve=>setImmediate(resolve));await second.session.open('other',DAY);
  waiting.resolve(bundle);await pending;assert.equal(second.session.snapshot().workspaceId,'other');
});
import {buildDailyPlanningInput} from '../app/task-planning-input.ts';
import {buildLongTermPlanningInput} from '../app/long-term-planning-input.ts';
import {generateLongTermSchedule} from '../app/long-term-pacing.ts';
test('enabled bundle drives the real local session, skips automatic extra suggestions and stays clean on future-only changes',async()=>{
 const {session,bundle,suggestions}=await fixture();const {input}=await buildDailyPlanningInput({...bundle,day:DAY,previous:null});const source=buildLongTermPlanningInput(input);
 bundle.longTermPlan=generateLongTermSchedule(source.inventory,{planId:'session-long',startDate:DAY,targetDeadline:DAY,dailyMinutesBudget:{workdayMin:0,workdayMax:3,weekendMax:3,minReviewRatio:0},subjectsConfig:input.catalog.subjects.map(s=>({subjectId:s.subjectId,priority:3,completionCriteria:'fixed-rounds'})),bufferRatio:0},{},{asOfDate:DAY,generatedAt:`${DAY}T00:00:00Z`});
 await session.refresh();await session.generate();let state=session.snapshot();assert.equal(state.draft.plan.vocabulary.target,1);assert.equal(state.summary.newTarget,1);assert.equal(suggestions.length,0);assert.ok(state.draft.plan.longTermAllocation);
 await session.save();state=session.snapshot();bundle.authority={revision:1,candidate:state.draft.plan,history:[]};bundle.context.planRevision=1;bundle.longTermPlan.lastRebalancedAt='2026-09-01T00:00:00Z';await session.refresh();assert.equal(session.snapshot().draft.dirty,false);
});
