import test from 'node:test';
import assert from 'node:assert/strict';
import {dashboardFunction,dashboardValue} from './fixtures/dashboard-functions.mjs';
import {createHooks,loader} from './helpers/causal-harness.mjs';
import {sealStudyItem,sealStudySnapshot} from '../app/account-study-content.ts';
import {sealStudyRecord} from '../app/account-study-record.ts';
import {toCloudPlanningCatalog,sealCloudPlanningFacts} from '../app/account-study-planning.ts';
import {composeAccountPlanningInput} from '../app/account-study-planning-projection.ts';
import {buildLongTermEditorSource} from '../app/long-term-editor-source.ts';
import {wordBody,snapshotBody,recordBody} from './fixtures/account-study-fixtures.mjs';
import {attempt} from './fixtures/task-event-fixtures.mjs';

function setup(account=false){
 const values={longTermScopeKey:'scope',longTermScopeRef:{current:'scope'},longTermSourceStampRef:{current:'version-a'},progressHistoryReady:true,accountWorkspaceId:account?'owner':null,accountLoaded:account?{bundle:{snapshot:{libraryId:'library'}},bundles:[],records:[],catalog:{},facts:{sourceReviews:[],observedAt:'2026-09-08T00:00:00Z'}}:null,submissionJournal:{},currentDay:'2026-09-08',accountDailyPlan:{state:null},longTermDailyReady:false,accountAttemptActiveRef:{current:false},workspaceId:'owner',taskLearning:{state:null},window:{setTimeout},readAccountLocalPractice:async()=>({bundles:[],records:[]}),composeAccountPlanningInput:async()=>({input:{},events:[]}),loadTaskBundle:async()=>({companionRecords:[],context:{sourceReviews:[],observedAt:'2026-09-08T00:00:00Z'},authority:{candidate:null}}),buildDailyPlanningInput:async()=>({input:{},events:[]}),buildLongTermEditorSource:async value=>value};
 return {values,load:()=>dashboardFunction('loadLongTermSource',values)()};
}
test('native longterm scope requires an actual task planning channel while AI retains legacy library scope',()=>{
 const values={nativeLibraryId:'library',data:{gateway:{mode:'indexed'}},companionSession:{capabilities:['task-planning-v1']},supportsTaskPlanning:caps=>caps.includes('task-planning-v1')};
 assert.equal(dashboardValue('nativeLongTermLibraryId',values),'library');
 values.data={};assert.equal(dashboardValue('nativeLongTermLibraryId',values),null);
 const ai=dashboardFunction('studyAI',{...values,accountWorkspaceId:null,accountLibraryId:null,accountWanted:false,workspaceId:'owner',companionUrl:'http://127.0.0.1:43224',createLocalStudyAIService:options=>({library:options.libraryId})})();
 assert.deepEqual(ai.scope,{ownerId:'owner',libraryId:'library',mode:'local'});assert.equal(ai.service.library,'library');
 values.data={gateway:{mode:'indexed'}};values.companionSession.capabilities=[];assert.equal(dashboardValue('nativeLongTermLibraryId',values),null);
});
for(const mode of ['account','local']){
 test(`${mode} unhydrated daily authority locks today`,async()=>{const {load}=setup(mode==='account');assert.equal((await load()).todayLocked,true);});
 test(`${mode} async source update rejects the old result instead of relabeling its stamp`,async()=>{const {values,load}=setup(mode==='account');values.buildLongTermEditorSource=async value=>{values.longTermSourceStampRef.current='version-b';return value;};await assert.rejects(load(),/long-term-source-changed/);});
}
test('fresh local authority locks today even when no local draft exists',async()=>{
 const {values,load}=setup();values.longTermDailyReady=true;const original=values.loadTaskBundle;values.loadTaskBundle=async()=>({...await original(),authority:{candidate:{day:values.currentDay}}});assert.equal((await load()).todayLocked,true);
});
test('automatic reconciliation waits for known daily authority before scheduling work',()=>{
 let scheduled=false;const hooks=createHooks(),load=loader(hooks.api,{}, {setTimeout:()=>{scheduled=true;return 1;},clearTimeout(){}});
 const useAutomaticPlanning=load('src/features/planning/use-automatic-planning.ts').useAutomaticPlanning;
 hooks.mount(()=>{useAutomaticPlanning({input:{scope:'scope',mode:'native',day:'2026-09-08',sourceStamp:'facts',trigger:'view',ready:false,state:{enabled:true,revision:1,snapshot:{}}},editing:false,historyReady:true,blocked:false,canContinue:()=>true,ports:{}});return null;},{});
 hooks.flush();assert.equal(scheduled,false);hooks.unmount();
});

const sourceStamp=values=>dashboardValue('longTermSourceEpoch',{...values,longTermFactsEpoch:dashboardValue('longTermFactsEpoch',values)});
test('native source refresh participates in source version even with stable item hashes',()=>{
 const values={workspaceId:'owner',accountLibraryId:null,currentDay:'2026-09-08',taskDataEpoch:'same-items',eventRevision:0,studySourceEpoch:0,accountLoaded:null,longTermDailyReady:true,accountDailyPlan:{state:null},taskLearning:{state:null},practiceItems:null,tab:'today'};
 const before=sourceStamp(values);values.studySourceEpoch++;assert.notEqual(sourceStamp(values),before);
});

test('unchanged account polls do not expire a preview but new local evidence does',()=>{
 const values={workspaceId:'owner',accountLibraryId:'library',currentDay:'2026-09-08',taskDataEpoch:'same-items',eventRevision:0,studySourceEpoch:0,accountLoaded:{facts:{factsHash:'facts'},catalog:{catalogHash:'catalog'},eventThrough:1,taskThrough:1},progressEvents:[{eventId:'one',coreHash:'core'}],longTermDailyReady:true,accountDailyPlan:{state:{revision:1}},taskLearning:{state:null},practiceItems:null,tab:'today'};
 const before=sourceStamp(values);values.eventRevision++;assert.equal(sourceStamp(values),before);
 values.progressEvents.push({eventId:'two',coreHash:'new-core'});assert.notEqual(sourceStamp(values),before);
});

test('verified account attempt uses portable content identity rather than the private source hash',async()=>{
 const item=await sealStudyItem(wordBody()),bundle={items:[item],snapshot:await sealStudySnapshot(snapshotBody([item]))};
 const native={schemaVersion:1,sourceHash:item.sourceHash,diagnostics:[],subjects:[{subjectId:'vocab',name:'Words',priority:3,planningStatus:'none',words:[{itemKey:item.itemKey,subjectId:'vocab',word:item.word.word,language:'en',sourceHash:item.sourceHash,completionRule:'three-stage'}],units:[],goals:[]}]};
 const {catalog}=await toCloudPlanningCatalog(native,bundle),facts=await sealCloudPlanningFacts({schemaVersion:1,libraryId:'library-a',snapshotId:'snapshot-a',catalogHash:catalog.catalogHash,observedAt:'2026-09-01T00:00:00.000Z',nativePlanRevision:0,sourceReviews:[],captureReviews:[],legacyEvents:[],legacyTaskEvents:[],contentCandidates:[],historyComplete:true});
 const record=await sealStudyRecord(await recordBody({contentHash:item.contentHash,practiceMode:'spelling',event:await attempt('one','2026-09-01T01:00:00Z',0,3,true,{item:{kind:'word',key:item.itemKey}})}));
 const {values,load}=setup(true);Object.assign(values,{currentDay:'2026-09-01',accountLoaded:{bundle,bundles:[bundle],records:[{sequence:1,record}],catalog,facts,eventThrough:1,taskThrough:1},composeAccountPlanningInput,buildLongTermEditorSource});
 assert.notEqual(item.sourceHash,item.contentHash);const result=await load();assert.equal(result.inventory[0].completedRounds,1);assert.ok(result.fsrsMap[item.itemKey]);assert.equal(result.history.length,1);
});
