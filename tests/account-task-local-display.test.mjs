import assert from 'node:assert/strict';
import test from 'node:test';
import {assistanceBundle} from './fixtures/assistance-read.mjs';
import {toCloudPlanningCatalog,toEnginePlanningCatalog,sealCloudPlanningFacts,sealCloudTaskPlan} from '../app/account-study-planning.ts';
import {composeAccountPlanningInput,accountTaskActivity} from '../app/account-study-planning-projection.ts';
import {generateTaskPlan} from '../app/task-plan-engine.ts';
import {editTaskPlan} from '../app/task-plan-edit.ts';
import {hashTaskEvent} from '../app/task-event-v1.ts';
import {sealStudyRecord} from '../app/account-study-record.ts';
import {studyHash} from '../app/account-study-content.ts';
import {tsxFunction} from './fixtures/tsx-functions.mjs';
async function fixture(){
  const bundle=assistanceBundle(),sourceHash='b'.repeat(64),native={schemaVersion:1,sourceHash,diagnostics:[],subjects:[{subjectId:'course',name:'Course',priority:3,planningStatus:'ready',words:[],units:[{unitId:'course:u1',subjectId:'course',title:'Lesson 1',order:1,sourceHash,prerequisites:[],action:{kind:'open-note',contentRef:'[[subjects/course/u1]]'},completionRule:'self-report',formalComplete:false}],goals:[]}]};
  const {catalog}=await toCloudPlanningCatalog(native,bundle),facts=await sealCloudPlanningFacts({schemaVersion:1,libraryId:'library-a',snapshotId:'snapshot-a',catalogHash:catalog.catalogHash,observedAt:'2026-09-01T00:00:00.000Z',nativePlanRevision:0,sourceReviews:[],captureReviews:[],legacyEvents:[],legacyTaskEvents:[],contentCandidates:[],historyComplete:true});
  const composed=await composeAccountPlanningInput({day:'2026-09-01',catalog,facts,bundle,records:[],eventThrough:0,taskThrough:0,previous:null}),engine=await toEnginePlanningCatalog(catalog),unit=engine.subjects.find(subject=>subject.subjectId==='course').units[0];
  const task={taskId:'manual:course:u1',subjectId:'course',title:'Lesson 1',category:'subject',origin:'manual',required:false,unitIds:[unit.unitId],quantity:1,action:unit.action,completionRule:'self-report',sourceHash:unit.sourceHash};
  const plan=await editTaskPlan(await generateTaskPlan(composed.input),{type:'upsert',task},engine),cloud=await sealCloudTaskPlan(plan,catalog,{baseRevision:0,factsHash:facts.factsHash,eventThrough:0,taskThrough:0,nativeBaseRevision:0});
  const body={schemaVersion:1,eventType:'task-completed',eventId:'local-self-report',taskId:task.taskId,subjectId:task.subjectId,day:plan.day,occurredAt:'2026-09-01T01:00:00.000Z',unitIds:task.unitIds,source:'self-report',evidenceRefs:[]},event={...body,coreHash:await hashTaskEvent(body)},record=await sealStudyRecord({schemaVersion:1,libraryId:'library-a',snapshotId:'snapshot-a',originDeviceId:'device',provenanceMode:'task',planHash:cloud.cloudPlanHash,assignmentId:task.taskId,completionKey:`completion:${await studyHash([cloud.cloudPlanHash,task.taskId,task.unitIds,plan.day])}`,event});
  return{bundle,catalog,cloud,record,body,task};
}
test('a source-bound local self-report can update the approved task display without a cloud sequence',async()=>{
  const f=await fixture(),remote=[];assert.deepEqual((await accountTaskActivity(f.cloud,f.catalog,[f.bundle],remote,[f.record])).completedTaskIds,[f.task.taskId]);assert.deepEqual(remote,[]);
});
test('same plan hash with different task units is not usable local completion evidence',async()=>{
  const f=await fixture(),body={...f.body,unitIds:['course:wrong']},event={...body,coreHash:await hashTaskEvent(body)},{envelopeHash,...raw}=f.record;void envelopeHash;
  const bad=await sealStudyRecord({...raw,event});await assert.rejects(accountTaskActivity(f.cloud,f.catalog,[f.bundle],[],[bad]),/task.*binding/);
});

test('the actual Today effect reads local task evidence and labels it pending account receipt',async()=>{
  const f=await fixture();let resolve,reject;const published=new Promise((yes,no)=>{resolve=yes;reject=no;}),env={state:{approvedPlan:f.cloud},loaded:{bundle:f.bundle,bundles:[f.bundle],catalogs:[f.catalog],records:[]},workspaceId:'account:a',submissionJournal:{},completionScope:'fixture',
    readAccountLocalPractice:async()=>({records:[],taskRecords:[f.record],bundles:[f.bundle]}),accountTaskActivity,setCompletedTaskIds(){},setTaskActivity:resolve,setCompletedScope(){},setMessage:value=>reject(new Error(value))};
  const cleanup=tsxFunction(new URL('../app/account-study-controls.tsx',import.meta.url),'AccountStudyPlan',env,{effect:'const plan=state?.approvedPlan'})();
  try{assert.deepEqual((await published).localOnlyTaskIds,[f.task.taskId]);}finally{cleanup();}
});

test('an exact task ACK is distinguished from an unconfirmed local task even before page readback',async()=>{
  const f=await fixture();let resolve,reject;const published=new Promise((yes,no)=>{resolve=yes;reject=no;}),env={state:{approvedPlan:f.cloud},loaded:{bundle:f.bundle,bundles:[f.bundle],catalogs:[f.catalog],records:[]},workspaceId:'account:a',submissionJournal:{},completionScope:'fixture',
    readAccountLocalPractice:async()=>({records:[],taskRecords:[f.record],taskAckedIds:new Set([f.record.event.eventId]),bundles:[f.bundle]}),accountTaskActivity,setCompletedTaskIds(){},setTaskActivity:resolve,setCompletedScope(){},setMessage:value=>reject(new Error(value))};
  const cleanup=tsxFunction(new URL('../app/account-study-controls.tsx',import.meta.url),'AccountStudyPlan',env,{effect:'const plan=state?.approvedPlan'})();
  try{const value=await published;assert.deepEqual(value.localOnlyTaskIds,[]);assert.deepEqual(value.localReceivedTaskIds,[f.task.taskId]);}finally{cleanup();}
});
