import test from 'node:test';
import assert from 'node:assert/strict';
import {createRestartBatch} from '../app/restart-batch.ts';
import {createLearningDraftStore} from '../app/learning-draft-store.ts';
import {withinDeadline} from '../app/action-deadline.ts';
import {manualSyncResult} from '../app/manual-sync-result.ts';
import {createSubjectRoundSessions,restoredSubjectRound,firstPendingRoundIndex,taskRoundIdentity,nativeTaskCompletedKeys} from '../app/subject-round-resume.ts';
import {advanceSubjectRound} from '../app/subject-round.ts';
import {registerStudyNavigationGuard,prepareStudyNavigation,confirmStudyNavigation} from '../app/study-navigation-guard.ts';
import {makeTrialMaterialBackup,readTrialMaterialBackup,mergeTrialMaterialBackup,parseBackupTrialMaterials,trialMaterialRecordKind} from '../app/trial-material-backup-model.ts';
import {hashLocalJson} from '../app/local-json-integrity.ts';
import {buildPaperReview} from '../app/paper-review-budget.ts';
import {emptyPaperDraft,DEMO_PAPER_ALEXNET} from '../app/paper-study.ts';
import {setPaperTemplate,setPaperSlot,paperTemplate} from '../app/paper-slot-templates.ts';
import {parseChatRequest} from '../app/ai/study-ai-chat.ts';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));

test('restart batch refuses a second execution while first write is pending',async()=>{
 const batch=createRestartBatch(['A','B']),wait=deferred(),seen=[];
 const pending=batch.run(async item=>{seen.push(item);if(item==='A')await wait.promise;},()=>true);
 assert.equal(batch.running,true);assert.equal(await batch.run(async()=>{throw Error('duplicate');},()=>true),'busy');assert.deepEqual(seen,['A']);wait.resolve();assert.equal(await pending,'complete');assert.deepEqual(seen,['A','B']);assert.equal(batch.completed,2);
});
test('restart partial failure resumes only the failed suffix',async()=>{
 const batch=createRestartBatch(['A','B','C']),seen=[];let fail=true;
 const apply=async item=>{seen.push(item);if(item==='B'&&fail)throw Error('disk full');};
 await assert.rejects(batch.run(apply,()=>true),/disk full/);assert.equal(batch.completed,1);fail=false;await batch.run(apply,()=>true);assert.deepEqual(seen,['A','B','B','C']);assert.equal(batch.completed,3);
});
test('restart stops processing more items after navigation invalidates the scope',async()=>{
 const batch=createRestartBatch(['A','B']),seen=[];let current=true;
 assert.equal(await batch.run(async item=>{seen.push(item);current=false;},()=>current),'stale');assert.deepEqual(seen,['A']);
});
test('restart shares the live grading lock and releases it after storage failure',async()=>{
 const store=createLearningDraftStore('reset'),wait=deferred();const work=store.grade(()=>wait.promise);
 assert.equal(store.adapter('A','v').begin(),null);await assert.rejects(store.grade(async()=>{}));wait.reject(Error('save failed'));await assert.rejects(work);assert.equal(store.isPending(),false);assert.ok(store.adapter('A','v').begin());
});
test('optional revoke completes normally without waiting for its deadline',async()=>{assert.deepEqual(await withinDeadline(async()=>7,100),{status:'fulfilled',value:7});});
test('optional revoke rejection is a result, not an unhandled rejection',async()=>{assert.deepEqual(await withinDeadline(async()=>{throw Error('offline');},100),{status:'rejected'});});
test('hung revoke that ignores abort still cannot block caller indefinitely',async()=>{let signal;const wait=deferred();assert.deepEqual(await withinDeadline(s=>{signal=s;return wait.promise;},10),{status:'timeout'});assert.equal(signal.aborted,true);wait.reject(Error('late'));await tick();});
test('deadline rejects invalid configuration before issuing external work',async()=>{await assert.rejects(withinDeadline(async()=>1,0));});
const receipts=(overrides={})=>({complete:true,pending:{coreUploads:[],coreWritebacks:[],recovery:[],assistance:[],tasks:[],legacyQueues:false,...overrides}});
test('download success does not acknowledge a pending upload',()=>{const value=manualSyncResult(true,receipts({coreUploads:['A']}));assert.equal(value.complete,false);assert.equal(value.status,'error');assert.match(value.message,/云端待接收 1/);assert.doesNotMatch(value.message,/学习进度已同步/);});
test('cloud and companion outstanding work stay distinct',()=>{const value=manualSyncResult(true,receipts({coreWritebacks:['A']}));assert.equal(value.complete,false);assert.match(value.message,/云端待接收 0/);assert.match(value.message,/本地助手待确认 1/);});
test('all verified empty queues can produce a complete result',()=>{assert.equal(manualSyncResult(true,receipts()).complete,true);});
test('partial reads and unsupported bootstrap cannot claim delivery success',()=>{assert.equal(manualSyncResult(true,{...receipts(),complete:false}).complete,false);assert.equal(manualSyncResult(false,receipts()).complete,false);});
test('journal-only summaries, task records and legacy queues prevent blanket success',()=>{for(const value of [{assistance:['A']},{tasks:['A']},{recovery:['A']},{legacyQueues:true}])assert.equal(manualSyncResult(true,receipts(value)).complete,false);});
const task={taskId:'task-a',sourceHash:'hash-a',action:{kind:'practice',itemKeys:['A','B']},category:'subject'};
test('resume after A then B completes without asking A again',()=>{const round=restoredSubjectRound(['A']);assert.equal(firstPendingRoundIndex(['A','B'],round,'B'),1);assert.equal(advanceSubjectRound({round,itemKeys:['A','B'],currentIndex:1,correct:true}).complete,true);});
test('a supplied resume position never implies preceding questions were correct',()=>{const round=restoredSubjectRound([]);assert.equal(advanceSubjectRound({round,itemKeys:['A','B'],currentIndex:1,correct:true}).complete,false);assert.equal(firstPendingRoundIndex(['A','B'],round),0);});
test('scoped round cache restores the same task without leaking another task state',()=>{const s=createSubjectRoundSessions();s.activate('subject','task1',restoredSubjectRound([]));s.set(prev=>({...prev,subject:restoredSubjectRound(['A'])}));s.activate('subject','task2',restoredSubjectRound(['C']));assert.deepEqual(s.activate('subject','task1',restoredSubjectRound([])).correctKeys,['A']);});
test('explicit restart and clear reset the relevant cached state',()=>{const s=createSubjectRoundSessions();s.activate('s','task',restoredSubjectRound(['A']));s.set(prev=>({...prev,s:restoredSubjectRound([])}));assert.deepEqual(s.activate('s','task',restoredSubjectRound(['A'])).correctKeys,[]);s.set({});assert.deepEqual(s.activate('s','task',restoredSubjectRound(['B'])).correctKeys,['B']);});
test('source, review round, day, account and library all contribute to resume identity',()=>{const base=taskRoundIdentity('a','lib','2026-09-15',task);for(const args of [['b','lib','2026-09-15',task],['a','other','2026-09-15',task],['a','lib','2026-09-16',task],['a','lib','2026-09-15',{...task,sourceHash:'new'}],['a','lib','2026-09-15',{...task,reviewRoundId:'new'}]])assert.notEqual(taskRoundIdentity(...args),base);});
const event=(key,correct,time='2026-09-15T01:00:00Z')=>({eventType:'practice-attempt',item:{key},eventId:key+time,occurredAt:time,attempt:{correct,stageAfter:correct?3:0}});
test('native resume uses current-day bound evidence only',()=>{assert.deepEqual(nativeTaskCompletedKeys(task,undefined,[event('A',true),event('B',true,'2026-09-14T01:00:00Z')],'2026-09-15'),['A']);});
test('latest failed native attempt remains in the pending queue',()=>{assert.deepEqual(nativeTaskCompletedKeys(task,undefined,[event('A',true),event('A',false,'2026-09-15T02:00:00Z')],'2026-09-15'),[]);});
test('a new review obligation cannot inherit evidence before its anchor',()=>{const review={...task,category:'review',reviewRoundId:'r'};assert.deepEqual(nativeTaskCompletedKeys(review,undefined,[event('A',true)],'2026-09-15'),[]);assert.deepEqual(nativeTaskCompletedKeys(review,{observedAt:'2026-09-15T02:00:00Z'},[event('A',true)],'2026-09-15'),[]);});
test('cancelled navigation retains the live trial and its pending operation',()=>{let left=0;const off=registerStudyNavigationGuard({message:()=> 'dirty',onLeave:()=>left++});try{assert.equal(confirmStudyNavigation(()=>false),false);assert.equal(left,0);}finally{off();}});
test('preparing an async navigation does not cancel input until a real transition',()=>{let left=0;const off=registerStudyNavigationGuard({message:()=> 'dirty',onLeave:()=>left++});try{const commit=prepareStudyNavigation(()=>true);assert.equal(left,0);assert.equal(commit(),true);assert.equal(left,1);}finally{off();}});
test('new input while an async transition is waiting requires fresh consent',()=>{let version=0,left=0,asks=0;const off=registerStudyNavigationGuard({message:()=> 'dirty',version:()=>version,onLeave:()=>left++});try{const commit=prepareStudyNavigation(()=>++asks===1);version++;assert.equal(commit(),false);assert.equal(left,0);assert.equal(asks,2);}finally{off();}});
test('unmounted or clean trials do not produce navigation prompts',()=>{const off=registerStudyNavigationGuard({message:()=>null,onLeave:()=>{throw Error('clean');}});try{assert.equal(confirmStudyNavigation(()=>{throw Error('unneeded');}),true);}finally{off();}});
async function material(title='Example'){const body={subject:'Math',title,questions:[{id:'q1',prompt:'Why?',answer:'Reference',filename:'source.md',section:'Conditions',kind:'qa'}]};const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(body)));return{id:'trial-'+Array.from(new Uint8Array(bytes),v=>v.toString(16).padStart(2,'0')).join(''),...body};}
test('standalone material backup preserves source questions and strips unknown fields',async()=>{const entry=await material(),backup=await makeTrialMaterialBackup('account:a','lib',[{...entry,secret:'not copied'}]);assert.deepEqual(await readTrialMaterialBackup(backup,'account:a','lib'),[entry]);assert.doesNotMatch(JSON.stringify(backup),/secret|not copied/);});
test('other owners and libraries cannot be silently imported',async()=>{const backup=await makeTrialMaterialBackup('account:a','lib',[await material()]);await assert.rejects(readTrialMaterialBackup(backup,'account:b','lib'));await assert.rejects(readTrialMaterialBackup(backup,'account:a','other'));});
test('guest materials have an explicit standalone backup format',async()=>{const backup=await makeTrialMaterialBackup('guest:local','local:offline',[await material()]);assert.equal((await readTrialMaterialBackup(backup,'guest:local','local:offline')).length,1);});
test('full recovery import reads only exact-owner exact-library material rows',async()=>{const entry=await material(),kind=trialMaterialRecordKind('lib'),payload={workspaceRecords:[{id:'account:a:'+kind,kind,workspaceId:'account:a',value:[entry]},{id:'secret',kind:'companion-session',workspaceId:'account:a',value:{token:'NOT_IMPORTED'}}]};const backup={format:'zhixue-study-recovery-v1',schemaVersion:1,workspaceId:'account:a',payload,payloadHash:await hashLocalJson(payload)};assert.deepEqual(await readTrialMaterialBackup(backup,'account:a','lib'),[entry]);});
test('missing old-format material row is explained rather than an empty restore success',async()=>{const payload={workspaceRecords:[]};await assert.rejects(readTrialMaterialBackup({format:'zhixue-study-recovery-v1',schemaVersion:1,workspaceId:'account:a',payload,payloadHash:await hashLocalJson(payload)},'account:a','lib'),/旧包/);});
test('corrupt material content, checksum, version and duplicate IDs fail closed',async()=>{const entry=await material(),backup=await makeTrialMaterialBackup('account:a','lib',[entry]);await assert.rejects(readTrialMaterialBackup({...backup,payloadHash:'bad'},'account:a','lib'));await assert.rejects(readTrialMaterialBackup({...backup,schemaVersion:2},'account:a','lib'));assert.throws(()=>parseBackupTrialMaterials([entry,entry]));await assert.rejects(makeTrialMaterialBackup('account:a','lib',[{...entry,title:'tampered'}]));});
test('restoring twice is idempotent, preserving existing material',async()=>{const a=await material('A'),b=await material('B');const first=mergeTrialMaterialBackup([a],[b]);assert.deepEqual(mergeTrialMaterialBackup(first,[b]),[a,b]);});
test('capacity and conflicting IDs do not overwrite existing materials',async()=>{const all=await Promise.all(Array.from({length:50},(_,i)=>material('m'+i)));assert.throws(()=>mergeTrialMaterialBackup(all,[{...all[0],title:'conflict'}]));const more=await material('overflow');assert.throws(()=>mergeTrialMaterialBackup(all,[more]));assert.equal(all.length,50);});
function chatRequest(built){return {requestId:'fixture',provider:'deepseek',model:'fixture',settingsRevision:1,context:built.context,messages:[{role:'user',content:built.prompt}]};}
for(const templateId of ['empirical','theory','free'])test('legal long '+templateId+' outline produces a valid bounded AI request',()=>{
 let draft=setPaperTemplate(emptyPaperDraft(),templateId);for(const field of paperTemplate(templateId).fields)draft=setPaperSlot(draft,field.key,'汉'.repeat(2999));
 const before=structuredClone(draft),paragraph={...DEMO_PAPER_ALEXNET.sections[0].paragraphs[0],rawEn:'示例段落'.repeat(800)};
 const built=buildPaperReview('主线检查',DEMO_PAPER_ALEXNET,paragraph,draft);assert.equal(built.truncated,true);assert.match(built.notice,/未发送部分不会被审阅/);assert.doesNotThrow(()=>parseChatRequest(chatRequest(built)));assert.deepEqual(draft,before);
});
test('short outlines retain normal content without falsely claiming truncation',()=>{const draft=setPaperSlot(emptyPaperDraft(),'motivation','short question'),built=buildPaperReview('核对',DEMO_PAPER_ALEXNET,DEMO_PAPER_ALEXNET.sections[0].paragraphs[0],draft);assert.equal(built.truncated,false);assert.match(built.prompt,/short question/);assert.doesNotThrow(()=>parseChatRequest(chatRequest(built)));});
test('escaped controls and Unicode still obey JSON body and per-field limits',()=>{let draft=emptyPaperDraft();for(const field of paperTemplate('empirical').fields)draft=setPaperSlot(draft,field.key,'\n\\"'.repeat(999));const paragraph={...DEMO_PAPER_ALEXNET.sections[0].paragraphs[0],rawEn:'😀\n'.repeat(1200)},built=buildPaperReview('核对',DEMO_PAPER_ALEXNET,paragraph,draft);const request=chatRequest(built);assert.ok(JSON.stringify(request).length<50000);assert.doesNotThrow(()=>parseChatRequest(request));assert.equal(/\uD83D(?!\uDE00)/u.test(built.prompt),false);});

test('invalid control characters fail locally with actionable feedback and no request',()=>{const paragraph={...DEMO_PAPER_ALEXNET.sections[0].paragraphs[0],rawEn:'text\u0001corrupt'};assert.throws(()=>buildPaperReview('核对',DEMO_PAPER_ALEXNET,paragraph,emptyPaperDraft()),/没有发送请求/);});
