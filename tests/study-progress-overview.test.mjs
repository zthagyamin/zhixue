import assert from 'node:assert/strict';
import test from 'node:test';
import {createAccountPreview} from './fixtures/account-preview.mjs';
import {createAccountStudyClient} from '../app/account-study-client.ts';
import {accountTaskActivity} from '../app/account-study-planning-projection.ts';
let model={};try{model=await import('../app/study-progress-model.ts');}catch(e){if(e.code!=='ERR_MODULE_NOT_FOUND')throw e;}

test('partial task visual counts use completed words from validated same-day evidence',async t=>{
  const origin='http://127.0.0.1:3004',f=await createAccountPreview({origin,scenario:'partial-15'});t.after(()=>f.close());
  const client=createAccountStudyClient({companionUrl:'http://127.0.0.1:43224',fetcher:(url,init)=>{const headers=new Headers(init?.headers);headers.set('Origin',origin);return f.handle(new Request(new URL(url,origin),{...init,headers}));}});
  const loaded=await client.load(),state=await client.getPlanState(f.day),task=state.approvedPlan.tasks.find(t=>t.category==='new-word');
  const result=await accountTaskActivity(state.approvedPlan,loaded.catalog,loaded.bundles,loaded.records);
  assert.deepEqual(result.itemProgressByTask?.[task.taskId],{completed:1,total:15});
  assert.deepEqual(result.completedTaskIds,[]);
  const duplicate=await accountTaskActivity(state.approvedPlan,loaded.catalog,loaded.bundles,loaded.records,loaded.records.map(r=>r.record));
  assert.deepEqual(duplicate.itemProgressByTask,result.itemProgressByTask);
});
test('progress ring counts fully completed items rather than partial stages or duplicate keys',()=>{
  assert.equal(typeof model.progressScopeSummary,'function');
  assert.deepEqual(model.progressScopeSummary(['a','b','c','a'],{a:3,b:2},true,true),{total:3,completed:1,percent:33,evidence:2});
  assert.equal(model.progressScopeSummary(['a'],{a:3},false,true).completed,null);
  assert.equal(model.progressScopeSummary(['a'],{a:3},true,false).percent,null);
});
test('recent records are deduplicated, scoped and ordered without inventing unknown assistance',()=>{
  assert.equal(typeof model.progressRecordRows,'function');
  const e=(id,key,time)=>({eventId:id,eventType:'practice-attempt',occurredAt:time,item:{key,kind:'word'},attempt:{correct:true,rating:3,stageBefore:0,stageAfter:1}});
  const a=e('a','word-a','2026-09-07T10:00:00Z'),b=e('b','word-a','2026-09-07T11:00:00Z');
  const rows=model.progressRecordRows({events:[a,b,a,e('other','word-b','2026-09-07T12:00:00Z'),{...a,eventId:'baseline',eventType:'review-baseline'}],keys:['word-a'],labels:{'word-a':'retain'},assistance:[],accountRecords:[]});
  assert.deepEqual(rows.map(r=>r.id),['b','a']);assert.equal(rows[0].title,'retain');
  assert.equal(rows[0].assistance,null);assert.equal(rows[0].accountReceived,false);
});

test('empty progress stays unknown and historical account rows keep their original content title',()=>{
  assert.equal(model.progressScopeSummary([],{},true,true).completed,null);
  const event={eventId:'old',eventType:'practice-attempt',occurredAt:'2026-09-01T00:00:00Z',item:{key:'a',kind:'word'},attempt:{correct:true,stageAfter:3}};
  const input={events:[event],keys:['a'],labels:{a:'new source title'},assistance:[],accountRecords:[{record:{event,provenanceMode:'verified-round',practiceMode:'three-stage',contentHash:'old-hash'}}],accountItems:[{itemKey:'a',contentHash:'old-hash',title:'original title'}]};
  assert.equal(model.progressRecordRows(input)[0].title,'original title');
  assert.equal(model.progressRecordRows({...input,accountItems:[]})[0].title,'历史练习内容');
});

test('a failed native history refresh blocks the progress display even when a prior projection exists',async()=>{
  const {dashboardValue}=await import('./fixtures/dashboard-functions.mjs');
  const base={isDemoMode:false,accountLoaded:null,accountWanted:false,nativeView:{ready:true,unresolvedKeys:[]},nativeHistoryError:'unavailable'};
  assert.equal(dashboardValue('nativeProgressChecking',base),true);
  assert.equal(dashboardValue('nativeProgressChecking',{...base,nativeHistoryError:''}),false);
});

test('progress plan reads ignore late completion and preserve failure as unknown',async()=>{
 const {tsxFunction}=await import('./fixtures/tsx-functions.mjs');
 const trace=[],loaded={catalogs:[{catalogHash:'c'}],bundle:{snapshot:{libraryId:'l'}},bundles:[],records:[]};
 let release;const pending=new Promise(resolve=>release=resolve);
 const env={loaded,plan:{catalogHash:'c'},journal:{},workspaceId:'account:a',scope:'a',setView:v=>trace.push(v),readAccountLocalPractice:async()=>{await pending;return{bundles:[],records:[]};},accountTaskActivity:async()=>({itemProgressByTask:{t:{completed:8,total:20}}})};
 const run=tsxFunction(new URL('../app/use-progress-plan-scope.ts',import.meta.url),'useProgressPlanScope',env,{effect:true});
 const cleanup=run();cleanup();release();await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(trace,[]);
 const failed=tsxFunction(new URL('../app/use-progress-plan-scope.ts',import.meta.url),'useProgressPlanScope',{...env,readAccountLocalPractice:async()=>{throw new Error('read failed');}},{effect:true});
 failed();await new Promise(resolve=>setImmediate(resolve));assert.equal(trace.at(-1).phase,'failed');assert.deepEqual(trace.at(-1).counts,{});
});

test('progress tabs follow the real plan order and retain unplanned historical subjects',()=>{
 assert.equal(typeof model.orderProgressModules,'function');
 const modules=[{id:'archive'},{id:'random-c'},{id:'random-a'}];
 assert.deepEqual(model.orderProgressModules(modules,['random-a','random-c','random-a']).map(m=>m.id),['random-a','random-c','archive']);
 assert.deepEqual(modules.map(m=>m.id),['archive','random-c','random-a']);
});

test('the rendered forecast follows the selected subject and retains named mobile controls',async()=>{
 const {loadTsx}=await import('./fixtures/tsx-components.mjs'),{createElement}=await import('react'),{renderToStaticMarkup}=await import('react-dom/server');
 const {StudyProgressOverview}=loadTsx(new URL('../app/study-progress-overview.tsx',import.meta.url));
 const props={ready:true,modules:[{id:'course',name:'任意课程',pluginType:'three-stage',itemKeys:['a'],lastSeenAt:'',todayCount:1}],activeId:'course',onSelect(){},subjects:[{id:'course',name:'任意课程',pluginType:'three-stage',items:[{accountItemKey:'a',word:'a'}]}],stages:{},events:[],accountRecords:[],accountItems:[],assistance:[],assistancePhase:'ready',fsrsData:{a:{due:new Date().toISOString()},other:{due:new Date().toISOString()}},onSettings(){},onDataInfo(){}};
 const html=renderToStaticMarkup(createElement(StudyProgressOverview,props));
 assert.match(html,/class="c-forecast-pillar"><strong>1<\/strong>/);assert.doesNotMatch(html,/class="c-forecast-pillar"><strong>2<\/strong>/);
 assert.match(html,/aria-label="数据说明"/);assert.match(html,/aria-label="同步状态"/);
 const pending=renderToStaticMarkup(createElement(StudyProgressOverview,{...props,ready:false}));assert.match(pending,/学习历史待核对/);assert.doesNotMatch(pending,/c-record-export/);
});

test('legacy guest generation retains its original callback behind the aligned empty state',async()=>{
 const {dashboardClick}=await import('./fixtures/dashboard-functions.mjs');let calls=0;
 await dashboardClick('c-legacy-generate',{generateTodayPlan:async()=>{calls++;}})({currentTarget:{closest:()=>null}});assert.equal(calls,1);
});
