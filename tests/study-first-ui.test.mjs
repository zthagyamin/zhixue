import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement as h} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {loadTsx} from './fixtures/tsx-components.mjs';
import {dashboardJsxProp,dashboardStudyModule,dashboardFunction} from './fixtures/dashboard-functions.mjs';
let ui={};
try{ui=loadTsx(new URL('../app/study-session-shell.tsx',import.meta.url));}catch(error){if(error.code!=='ENOENT')throw error;}
const {StudyItemSource}=loadTsx(new URL('../app/study-item-source.tsx',import.meta.url));
let model={};
try{model=await import('../app/study-view-model.ts');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}

test('both account and local Today branches opt into the study-first presentation',()=>{
  assert.equal(dashboardJsxProp('TodayLearning','studyFirst',{}),true);
  assert.equal(dashboardJsxProp('AccountStudyPlan','studyFirst',{}),true);
});

test('settings labels use the verified durable queue rather than empty legacy arrays',()=>{
  const base={cloudOutbox:[],pendingActivities:[]};
  assert.equal(dashboardFunction('settingsDeliveryLabel',{...base,settingsReadView:null}),'待同步情况待核对');
  assert.equal(dashboardFunction('settingsDeliveryLabel',{...base,settingsReadView:{pending:{total:2}}}),'2 项本机待同步');
  assert.equal(dashboardFunction('settingsDeliveryLabel',{...base,settingsReadView:{pending:{total:0}}}),'当前本机队列为空');
});

test('the account connection indicator cannot turn red merely because local Companion is offline',()=>{
  const base={accountLoaded:{},syncState:'offline'};
  for(const [phase,expected] of [['ready','connected'],['cached','key_missing'],['loading','pending'],['failed','offline']]){
    assert.equal(dashboardFunction('visibleSyncState',{...base,visibleAccountStatus:{phase}}),expected);
  }
  assert.equal(dashboardFunction('visibleSyncState',{accountLoaded:null,syncState:'key_missing',visibleAccountStatus:{phase:'local'}}),'key_missing');
});

test('legacy migration setup does not interrupt focused learning or an already-account-backed workspace',()=>{
  assert.equal(dashboardFunction('showMigrationBanner',{studyFocus:true,accountLoaded:null,cloudStatus:'needs-migration'}),false);
  assert.equal(dashboardFunction('showMigrationBanner',{studyFocus:false,accountLoaded:{},cloudStatus:'needs-migration'}),false);
  assert.equal(dashboardFunction('showMigrationBanner',{studyFocus:false,accountLoaded:null,cloudStatus:'needs-migration'}),true);
});

test('unavailable study states retain an exit while global navigation is hidden',()=>{
  const base={tab:'words',freeStudySubject:null,setFreeStudySubject(){},navigateToStudyTab(){},StudyRecoveryState:ui.StudyRecoveryState};
  const pending=dashboardStudyModule({...base,accountLoaded:{},accountDailyPlan:{ready:false,error:'网络暂不可用',refresh(){}},activeTaskScope:null});
  const html=renderToStaticMarkup(pending({id:'words'}));
  assert.match(html,/网络暂不可用/);assert.match(html,/返回今日/);assert.match(html,/重新同步计划/);
  const empty=dashboardStudyModule({...base,accountLoaded:null,isVocabularySubject:()=>false,pacingForSubject:()=>({}),subjectPacing:{}});
  const emptyHtml=renderToStaticMarkup(empty({id:'words',items:[]}));
  assert.match(emptyHtml,/暂无学习内容/);assert.match(emptyHtml,/返回今日/);
});

test('failed account plan read offers explicit cached free study without marking the plan ready',()=>{
  let freeStudySubject=null;
  const accountDailyPlan={ready:false,error:'计划暂时无法读取',refresh(){}};
  const bindings=()=>({tab:'words',accountLoaded:{},accountDailyPlan,activeTaskScope:null,freeStudySubject,setFreeStudySubject:value=>{freeStudySubject=value;},navigateToStudyTab(){throw new Error('must not reset free-study intent');},StudyRecoveryState:ui.StudyRecoveryState,
    isVocabularySubject(){throw new Error('cached-question-pipeline');}});
  const recovery=dashboardStudyModule(bindings())({id:'words'});
  const button=recovery.props.children.find(child=>child?.props?.children==='使用已缓存资料自由学习');
  assert.ok(button,'cached questions need a reachable free-study action');button.props.onClick();
  assert.equal(freeStudySubject,'words');assert.equal(accountDailyPlan.ready,false);
  assert.throws(()=>dashboardStudyModule(bindings())({id:'words'}),/cached-question-pipeline/);
  accountDailyPlan.error='仍然离线';
  assert.throws(()=>dashboardStudyModule(bindings())({id:'words'}),/cached-question-pipeline/);
  freeStudySubject=null;accountDailyPlan.ready=true;
  const stale=dashboardStudyModule(bindings())({id:'words'});
  assert.match(renderToStaticMarkup(stale),/使用已缓存资料自由学习/);
  accountDailyPlan.error=null;
  const recovered=dashboardStudyModule(bindings())({id:'words'});
  assert.match(renderToStaticMarkup(recovered),/继续今日任务/,'Recovery cannot fall through to the old single-task adapter once the plan becomes ready');
});

test('source link is available only with a paired local reader, never as an unusable account phone file link',()=>{
  const base={StudyItemSource,data:{source:{title:'学习知识库',scope:'固定索引'}},currentItem:{sourceNote:'课程/讲义.md'},companionSession:{},syncState:'connected',workspaceId:'account:fixture',accountLibraryId:'fixture-library',markdownNotePath:value=>value??'',getObsidianUri:value=>`obsidian://open?file=${encodeURIComponent(value)}`};
  const desktop=renderToStaticMarkup(dashboardJsxProp('StudySessionShell','source',{...base,accountLoaded:null}));
  assert.match(desktop,/href="obsidian:\/\/open/);
  for(const mode of [{accountLoaded:{bundle:{}}},{accountLoaded:null,companionSession:null},{accountLoaded:null,syncState:'disconnected'}]){
    const html=renderToStaticMarkup(dashboardJsxProp('StudySessionShell','source',{...base,...mode}));
    assert.doesNotMatch(html,/href="obsidian:/);assert.match(html,/本机/);
  }
});

test('study content precedes optional settings and remains outside the settings dialog',()=>{
  assert.equal(typeof ui.StudySessionShell,'function','A real study shell must present the activity before its optional controls');
  const html=renderToStaticMarkup(h(ui.StudySessionShell,{title:'学术英语',scope:'今日任务 · 本组 15 词',progress:'已完成 4 / 15',mode:'三阶段背词',onExit(){},
    options:h('select',{'aria-label':'本学科默认'},h('option',{},'AI 推荐')),source:h('p',{},'来源仍属于学习知识库'),queue:h('button',{},'下一词'),subjects:h('button',{},'阅读'),
  },h('input',{'aria-label':'当前学习内容',defaultValue:'retrieval'})));
  assert.ok(html.indexOf('当前学习内容')<html.indexOf('本学科默认'));
  assert.ok(html.indexOf('当前学习内容')<html.indexOf('<dialog'));
  assert.match(html,/今日任务 · 本组 15 词/);
  assert.match(html,/已完成 4 \/ 15/);
  assert.match(html,/aria-haspopup="dialog"/);
  assert.doesNotMatch(html,/<dialog[^>]*\sopen(?:[\s=>])/);
  assert.match(html,/学习选项/);
  assert.match(html,/查看来源/);
});

test('pending plan state does not pretend zero tasks have been verified',()=>{
  assert.equal(typeof model.studyPlanSummary,'function');
  assert.deepEqual(model.studyPlanSummary({ready:false,hasPlan:false,total:0,completed:0}),{state:'loading',label:'正在核对今日安排',remaining:null});
});

test('Today puts execution before subject browsing and keeps connection detail collapsed',()=>{
  assert.equal(typeof ui.StudyTodayLayout,'function');
  const html=renderToStaticMarkup(h(ui.StudyTodayLayout,{plan:h('button',{},'执行真实计划'),modules:h('button',{},'自由选科'),context:h('button',{},'同步设置')}));
  assert.ok(html.indexOf('执行真实计划')<html.indexOf('自由选科'));
  assert.ok(html.indexOf('自由选科')<html.indexOf('同步设置'));
  assert.match(html,/<h2>按学科学习<\/h2>/);assert.doesNotMatch(html,/<h2>自由学习<\/h2>/);
  assert.doesNotMatch(html,/<details[^>]*\sopen(?:[\s=>])/);
});

test('Today does not conceal a known connection or source problem inside closed details',()=>{
  assert.equal(typeof ui.StudyTodayLayout,'function');
  const html=renderToStaticMarkup(h(ui.StudyTodayLayout,{plan:null,modules:null,context:'需要核对资料',contextAlert:true}));
  assert.match(html,/<details[^>]*\sopen=""/);
});

test('a missing or empty plan never becomes an all-complete claim',()=>{
  assert.equal(typeof model.studyPlanSummary,'function');
  assert.deepEqual(model.studyPlanSummary({ready:true,hasPlan:false,total:0,completed:0}),{state:'empty',label:'还没有今日安排',remaining:null});
  assert.deepEqual(model.studyPlanSummary({ready:true,hasPlan:true,total:0,completed:0}),{state:'empty',label:'当前没有可执行任务',remaining:0});
});

test('approved task totals retain exact completion and remaining counts',()=>{
  assert.equal(typeof model.studyPlanSummary,'function');
  assert.deepEqual(model.studyPlanSummary({ready:true,hasPlan:true,total:15,completed:4}),{state:'active',label:'已完成 4 / 15 项',remaining:11});
  assert.deepEqual(model.studyPlanSummary({ready:true,hasPlan:true,total:15,completed:15}),{state:'complete',label:'本次安排已完成',remaining:0});
});
