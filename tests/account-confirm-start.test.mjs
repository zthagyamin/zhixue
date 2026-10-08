import assert from 'node:assert/strict';
import test from 'node:test';
import {tsxFunction} from './fixtures/tsx-functions.mjs';
import {createPlanConfirmationSession} from '../src/application/planning/index.ts';
import {createAccountPlanStartAdapter} from '../app/study-dashboard/account-planning-adapter.ts';
const file=new URL('../app/account-study-controls.tsx',import.meta.url);
function scenario(options={}){
 const trace=[],draft={day:'2026-09-11',cloudPlanHash:'draft',catalogHash:'catalog',tasks:[{taskId:'first',title:'Question',action:{kind:'practice',itemKeys:['question']}}]},state={day:draft.day,revision:4,currentPlan:draft,approvedPlan:null,approvedOperationId:null};
 const fresh={...state,revision:5,approvedPlan:draft,approvedOperationId:'approval'};
 const loaded={bundle:{snapshot:{libraryId:'library'}},catalogs:[{catalogHash:'catalog',libraryId:'library',snapshotId:'snapshot'}],bundles:[{snapshot:{snapshotId:'snapshot',libraryId:'library'},items:[{itemKey:'question',kind:'practice',practice:{questionType:'recall',prompt:'What is the condition?',answer:'An independent sample.'}}]}],records:[]};
 let reads=0;
 const bindings={planConfirmation:createPlanConfirmationSession(()=> 'approval'),createAccountPlanStartAdapter,state,loaded,day:draft.day,workspaceId:'account:test',submissionJournal:{},busy:false,activePractice:false,approvalStartBusy:{current:false},approvalStartEpoch:{current:0},
 setBusy:v=>trace.push(['busy',v]),setMessage:v=>trace.push(['message',v]),setEditorOpen:v=>trace.push(['editor',v]),onStart:(...args)=>trace.push(['start',...args]),
 crypto:{randomUUID:()=> 'approval'},assertAccountPlanEvidence:async()=>{trace.push(['evidence']);if(options.evidenceFails)throw Error('incomplete evidence');},
 client:{mutatePlan:async m=>{trace.push(['approve',m]);if(options.networkFails)throw Error('network');return {status:options.status??'accepted'};}},
 refreshPlanState:async()=>{reads++;trace.push(['read']);if(options.scopeChanges)bindings.approvalStartEpoch.current++;return options.changed&&reads===2?{...fresh,revision:6,approvedOperationId:'other'}:options.missingReceipt?{...fresh,approvedOperationId:null}:options.wrongHash?{...fresh,approvedPlan:{...draft,cloudPlanHash:'other'}}:fresh;},
 prepareAccountPlanSource:async()=>{if(options.missingSource)throw Error('missing source');return {plan:{planHash:'engine'},catalog:{id:'engine-catalog'},cloud:draft,cloudCatalog:loaded.catalogs[0],bundle:loaded.bundles[0]};},
 readAccountLocalPractice:async()=>({bundles:[],records:[],taskRecords:[]}),accountTaskActivity:async()=>({completedTaskIds:options.done?['first']:[],startedTaskIds:[],pendingItemByTask:{first:'resume'}}),
 selectStudyTask:({completedTaskIds})=>completedTaskIds.length?null:{taskId:'first'}};
 Object.assign(bindings,options.bindings);return {trace,bindings,run:()=>tsxFunction(file,'confirmAndStart',bindings)()};
}
test('confirmation approves the shown revision then starts only the matching read-back plan',async()=>{
 const s=scenario();await s.run();const approve=s.trace.find(x=>x[0]==='approve')[1],start=s.trace.find(x=>x[0]==='start');
 assert.deepEqual(approve,{action:'approve',operationId:'approval',expectedRevision:4,day:'2026-09-11',planHash:'draft',predecessorOperationId:null});
 assert.equal(start[2],'first');assert.equal(start[4].cloudPlanHash,'draft');assert.equal(start[5],'resume');
 assert.equal(s.trace.filter(x=>x[0]==='read').length,2);assert.equal(s.trace.filter(x=>x[0]==='evidence').length,2);
});
for(const options of [{status:'stale'},{status:'blocked'},{networkFails:true},{evidenceFails:true},{missingReceipt:true},{wrongHash:true},{missingSource:true},{changed:true},{scopeChanges:true},{done:true}])test(`confirmation refuses unsafe start: ${JSON.stringify(options)}`,async()=>{
 const s=scenario(options);await s.run();assert.equal(s.trace.some(x=>x[0]==='start'),false);assert.equal(s.bindings.approvalStartBusy.current,false);
});
test('rapid repeated confirmation submits one approval',async()=>{const s=scenario();await Promise.all([s.run(),s.run()]);assert.equal(s.trace.filter(x=>x[0]==='approve').length,1);assert.equal(s.trace.filter(x=>x[0]==='start').length,1);});
test('an ongoing practice cannot be replaced by confirm and start',async()=>{const s=scenario({bindings:{activePractice:true}});await s.run();assert.deepEqual(s.trace,[]);});
