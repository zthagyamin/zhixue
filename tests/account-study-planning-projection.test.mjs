import assert from 'node:assert/strict';
import test from 'node:test';
import {sealStudyItem,sealStudySnapshot} from '../app/account-study-content.ts';
import {sealStudyRecord} from '../app/account-study-record.ts';
import {toCloudPlanningCatalog,sealCloudPlanningFacts} from '../app/account-study-planning.ts';
import {generateTaskPlan,remainingNewWords} from '../app/task-plan-engine.ts';
import {wordBody,snapshotBody,recordBody} from './fixtures/account-study-fixtures.mjs';
import {attempt} from './fixtures/task-event-fixtures.mjs';
import {hashTaskEvent} from '../app/task-event-v1.ts';
let api;
try {api=await import('../app/account-study-planning-projection.ts');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
async function setup(count=25){
  const items=await Promise.all(Array.from({length:count},(_,i)=>sealStudyItem(wordBody({itemKey:`word:${i}`,title:`term${i}`,
    word:{...wordBody().word,word:`term${i}`,example:`${i} in context.`}}))));
  const snapshot=await sealStudySnapshot(snapshotBody(items)),bundle={snapshot,items};
  const native={schemaVersion:1,sourceHash:'a'.repeat(64),diagnostics:[],subjects:[{subjectId:'vocab',name:'Words',priority:3,planningStatus:'none',
    words:items.map((item,i)=>({itemKey:item.itemKey,subjectId:'vocab',word:`term${i}`,language:'en',sourceHash:'a'.repeat(64),completionRule:'three-stage'})),units:[],goals:[]}]};
  const {catalog}=await toCloudPlanningCatalog(native,bundle),facts=await sealCloudPlanningFacts({schemaVersion:1,libraryId:'library-a',snapshotId:'snapshot-a',catalogHash:catalog.catalogHash,
    observedAt:'2026-09-01T00:00:00.000Z',nativePlanRevision:0,sourceReviews:[],captureReviews:[],legacyEvents:[],legacyTaskEvents:[],contentCandidates:[],historyComplete:true});
  return {items,bundle,catalog,facts};
}
async function wordRound(item,index,mode='three-stage'){
  const body=await recordBody({contentHash:item.contentHash,roundId:`round-${index}`,attemptId:`attempt-${index}-one`,practiceMode:mode,
    event:await attempt(`event-${index}-one`,'2026-09-01T01:00:00Z',0,mode==='three-stage'?1:3,true,{item:{kind:'word',key:item.itemKey}})});
  const first=await sealStudyRecord(body);if(mode!=='three-stage')return [first];
  const second=await sealStudyRecord({...body,attemptId:`attempt-${index}-two`,parentEventId:first.event.eventId,event:await attempt(`event-${index}-two`,'2026-09-01T01:01:00Z',1,2,true,{item:{kind:'word',key:item.itemKey}})});
  const third=await sealStudyRecord({...body,attemptId:`attempt-${index}-three`,parentEventId:second.event.eventId,event:await attempt(`event-${index}-three`,'2026-09-01T01:02:00Z',2,3,true,{item:{kind:'word',key:item.itemKey}})});
  return [first,second,third];
}
test('journal-only practice participates in planning without fabricating cloud sequence numbers',async()=>{
  const data=await setup(20),localPracticeRecords=await wordRound(data.items[0],0);
  const input={...data,day:'2026-09-01',records:[],eventThrough:0,taskThrough:0,previous:null,localPracticeRecords};
  const result=await api.composeAccountPlanningInput(input);assert.equal(result.events.length,3);assert.equal(remainingNewWords('2026-09-01',result.input.words),19);
  assert.equal(input.eventThrough,0);assert.deepEqual(input.records,[]);
});
test('local and cloud copies of one attempt are deduplicated while an incomplete cloud fence is still rejected',async()=>{
  const data=await setup(20),round=await wordRound(data.items[0],0),input={...data,day:'2026-09-01',records:round.slice(0,2).map((record,index)=>({sequence:index+1,record})),eventThrough:2,taskThrough:2,previous:null,localPracticeRecords:round};
  const result=await api.composeAccountPlanningInput(input);assert.equal(result.events.length,3);assert.equal(remainingNewWords('2026-09-01',result.input.words),19);
  await assert.rejects(api.composeAccountPlanningInput({...input,records:[],eventThrough:2}),/fence/);
});
test('journal-only incomplete or foreign-library practice cannot manufacture plan completion',async()=>{
  const data=await setup(20),round=await wordRound(data.items[0],0),input={...data,day:'2026-09-01',records:[],eventThrough:0,taskThrough:0,previous:null};
  await assert.rejects(api.composeAccountPlanningInput({...input,localPracticeRecords:[round[2]]}),/ancestry/);
  const {envelopeHash,...body}=round[0];void envelopeHash;const foreign=await sealStudyRecord({...body,libraryId:'foreign'});
  await assert.rejects(api.composeAccountPlanningInput({...input,localPracticeRecords:[foreign]}),/binding/);
});
test('verified word chains project seven completions so thirteen remain, without fake stages',async()=>{
  assert.equal(typeof api?.composeAccountPlanningInput,'function','Account planning projection must exist');const setupData=await setup(),records=[];
  for(let i=0;i<7;i++)records.push(...await wordRound(setupData.items[i],i));
  const result=await api.composeAccountPlanningInput({...setupData,day:'2026-09-01',records:records.map((record,sequence)=>({sequence:sequence+1,record})),eventThrough:records.length,taskThrough:records.length,previous:null});
  assert.equal(remainingNewWords('2026-09-01',result.input.words),13);assert.equal((await generateTaskPlan(result.input)).vocabulary.assignedLexemeKeys.length,20);
  assert.equal(result.events.filter(event=>event.attempt?.stageAfter===3).length,7);
});
test('spelling completion is one original 0→3 event and counts once',async()=>{
  const setupData=await setup(20),records=await wordRound(setupData.items[0],0,'spelling');
  const result=await api.composeAccountPlanningInput({...setupData,day:'2026-09-01',records:[{sequence:1,record:records[0]}],eventThrough:1,taskThrough:1,previous:null});
  assert.equal(remainingNewWords('2026-09-01',result.input.words),19);assert.equal(result.events.length,1);assert.equal(result.events[0].attempt.stageBefore,0);
});
test('mandatory current source review stays separate from 20 new words',async()=>{
  const setupData=await setup(20),factBody={...setupData.facts};delete factBody.factsHash;
  factBody.sourceReviews=[{itemKey:'word:0',subjectId:'vocab',completionRule:'three-stage',sourceHash:setupData.catalog.contentRefs['word:0'],state:{enabled:true,dueAt:'2026-08-31T00:00:00+08:00'}}];
  setupData.facts=await sealCloudPlanningFacts(factBody);
  const result=await api.composeAccountPlanningInput({...setupData,day:'2026-09-01',records:[],eventThrough:0,taskThrough:0,previous:null});
  const plan=await generateTaskPlan(result.input);assert.equal(plan.vocabulary.assignedLexemeKeys.length,20);assert.equal(plan.tasks.filter(t=>t.category==='review'&&t.required).length,1);
});
test('missing ancestry or a fork blocks plan generation instead of treating word as unseen',async()=>{
  const setupData=await setup(),chain=await wordRound(setupData.items[0],0);
  await assert.rejects(api.composeAccountPlanningInput({...setupData,day:'2026-09-01',records:[{sequence:1,record:chain[2]}],eventThrough:1,taskThrough:1,previous:null}),/history|ancestry/);
  const forkRaw={...chain[2],attemptId:'fork-attempt',event:await attempt('fork-event','2026-09-01T01:03:00Z',2,3,true,{item:{kind:'word',key:setupData.items[0].itemKey}})};delete forkRaw.envelopeHash;const fork=await sealStudyRecord(forkRaw);
  await assert.rejects(api.composeAccountPlanningInput({...setupData,day:'2026-09-01',records:[...chain,fork].map((record,i)=>({sequence:i+1,record})),eventThrough:4,taskThrough:4,previous:null}),/history|fork/);
});
test('facts and record coverage must match catalog/library/fences exactly',async()=>{
  const setupData=await setup();await assert.rejects(api.composeAccountPlanningInput({...setupData,day:'2026-09-01',records:[],eventThrough:1,taskThrough:0,previous:null}),/fence/);
  await assert.rejects(api.composeAccountPlanningInput({...setupData,facts:{...setupData.facts,libraryId:'other'},day:'2026-09-01',records:[],eventThrough:0,taskThrough:0,previous:null}),/facts|integrity/);
});
test('verified account task records participate in the next planning completion projection',async()=>{
  const setupData=await setup(),sourceHash='b'.repeat(64),native={schemaVersion:1,sourceHash,diagnostics:[],subjects:[{subjectId:'course',name:'Course',priority:3,planningStatus:'ready',words:[],units:[{unitId:'course:u1',subjectId:'course',title:'Lesson 1',order:1,sourceHash,prerequisites:[],action:{kind:'open-note',contentRef:'[[subjects/course/u1]]'},completionRule:'self-report',formalComplete:false}],goals:[]}]};
  const {catalog}=await toCloudPlanningCatalog(native,setupData.bundle),facts=await sealCloudPlanningFacts({schemaVersion:1,libraryId:'library-a',snapshotId:'snapshot-a',catalogHash:catalog.catalogHash,observedAt:'2026-09-01T00:00:00.000Z',nativePlanRevision:0,sourceReviews:[],captureReviews:[],legacyEvents:[],legacyTaskEvents:[],contentCandidates:[],historyComplete:true});
  const body={schemaVersion:1,eventType:'task-completed',eventId:'task-event-account-one',taskId:'manual:course:u1',subjectId:'course',day:'2026-09-01',occurredAt:'2026-09-01T01:00:00.000Z',unitIds:['course:u1'],source:'self-report',evidenceRefs:[]};
  const event={...body,coreHash:await hashTaskEvent(body)},record=await sealStudyRecord({schemaVersion:1,libraryId:'library-a',snapshotId:'snapshot-a',originDeviceId:'phone-device',provenanceMode:'task',planHash:'e'.repeat(64),assignmentId:'manual:course:u1',completionKey:'completion:task-one',event});
  const result=await api.composeAccountPlanningInput({day:'2026-09-01',catalog,facts,bundle:setupData.bundle,records:[{sequence:1,record}],eventThrough:1,taskThrough:1,previous:null});
  assert.equal(result.taskEvents.length,1);assert.equal(result.input.completions.length,1);assert.equal(result.input.completions[0].unitId,'course:u1');
});
test('historical record snapshots remain valid after the current content snapshot advances',async()=>{const old=await setup(20),records=await wordRound(old.items[0],0),newItems=await Promise.all(old.items.map((item,index)=>sealStudyItem(wordBody({itemKey:item.itemKey,title:item.title,word:{...item.word,meaning:index===0?'树木':item.word.meaning}})))),snapshot=await sealStudySnapshot(snapshotBody(newItems,{snapshotId:'snapshot-b',revision:2,items:newItems.map(item=>({itemKey:item.itemKey,contentHash:item.contentHash}))})),bundle={snapshot,items:newItems},native={schemaVersion:1,sourceHash:'a'.repeat(64),diagnostics:[],subjects:[{subjectId:'vocab',name:'Words',priority:3,planningStatus:'none',words:newItems.map((item,i)=>({itemKey:item.itemKey,subjectId:'vocab',word:`term${i}`,language:'en',sourceHash:'a'.repeat(64),completionRule:'three-stage'})),units:[],goals:[]}]},{catalog}=await toCloudPlanningCatalog(native,bundle),facts=await sealCloudPlanningFacts({schemaVersion:1,libraryId:'library-a',snapshotId:'snapshot-b',catalogHash:catalog.catalogHash,observedAt:'2026-09-01T00:00:00.000Z',nativePlanRevision:0,sourceReviews:[],captureReviews:[],legacyEvents:[],legacyTaskEvents:[],contentCandidates:[],historyComplete:true}),result=await api.composeAccountPlanningInput({day:'2026-09-01',catalog,facts,bundle,bundles:[old.bundle,bundle],records:records.map((record,index)=>({sequence:index+1,record})),eventThrough:3,taskThrough:3,previous:null});assert.equal(result.events.length,3);assert.equal(remainingNewWords('2026-09-01',result.input.words),19);});
test('reusing a physical item key for a different lexeme never credits the new word with old evidence',async()=>{const old=await setup(20),records=await wordRound(old.items[0],0),newItems=await Promise.all(old.items.map((item,index)=>sealStudyItem(wordBody({itemKey:item.itemKey,title:index===0?'renamed':item.title,word:{...item.word,word:index===0?'renamed':item.word.word,meaning:index===0?'新词':item.word.meaning,example:index===0?'Renamed is new.':item.word.example}})))),snapshot=await sealStudySnapshot(snapshotBody(newItems,{snapshotId:'snapshot-renamed',revision:2})),bundle={snapshot,items:newItems},native={schemaVersion:1,sourceHash:'a'.repeat(64),diagnostics:[],subjects:[{subjectId:'vocab',name:'Words',priority:3,planningStatus:'none',words:newItems.map(item=>({itemKey:item.itemKey,subjectId:'vocab',word:item.word.word,language:'en',sourceHash:item.sourceHash,completionRule:'three-stage'})),units:[],goals:[]}]},{catalog}=await toCloudPlanningCatalog(native,bundle),facts=await sealCloudPlanningFacts({schemaVersion:1,libraryId:'library-a',snapshotId:snapshot.snapshotId,catalogHash:catalog.catalogHash,observedAt:'2026-09-01T00:00:00.000Z',nativePlanRevision:0,sourceReviews:[],captureReviews:[],legacyEvents:[],legacyTaskEvents:[],contentCandidates:[],historyComplete:true}),result=await api.composeAccountPlanningInput({day:'2026-09-01',catalog,facts,bundle,bundles:[old.bundle,bundle],records:records.map((record,index)=>({sequence:index+1,record})),eventThrough:3,taskThrough:3,previous:null});assert.equal(remainingNewWords('2026-09-01',result.input.words),20);});
