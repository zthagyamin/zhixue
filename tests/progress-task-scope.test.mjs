import assert from 'node:assert/strict';
import test from 'node:test';
import {createHooks,loader,nodes,text,tick} from './helpers/causal-harness.mjs';

function fixture(){
  const hooks=createHooks();
  let planView={phase:'ready',counts:{first:{completed:1,total:1},second:{completed:0,total:2}}};
  const load=loader(hooks.api,{
    'app/use-progress-plan-scope.ts':{useProgressPlanScope:()=>planView},
    'app/dynamic-ui-model.ts':{stableStudyItemKey:item=>item.accountItemKey},
    'app/assistance-summary.ts':{assistanceObservationLabel:()=>''},
    'app/study-submission-status.ts':{auxiliaryDeliveryLabel:()=>''},
    'app/plugin-routing.ts':{pluginLabels:{}},
    'app/learning-metrics.ts':{forecastDue:()=>({days:[],overdue:0})},
  });
  const tasks=[
    {taskId:'first',subjectId:'course',category:'new-word',title:'今日新词',quantity:1,action:{kind:'practice',itemKeys:['q1']}},
    {taskId:'second',subjectId:'course',category:'review',title:'课程复习第二组',quantity:2,action:{kind:'practice',itemKeys:['q2','q3']}},
  ];
  const props={ready:true,modules:[{id:'course',name:'合成课程',pluginType:'recall',itemKeys:['q1','q2','q3']}],activeId:'course',onSelect(){},
    subjects:[{id:'course',name:'合成课程',items:['q1','q2','q3'].map(accountItemKey=>({accountItemKey}))}],
    stages:{q1:3,q2:3,q3:3},events:[],accountRecords:[],accountItems:[],assistance:[],assistancePhase:'ready',fsrsData:{},
    accountPlan:{workspaceId:'account:one',loaded:{bundle:{snapshot:{libraryId:'library-one'}}},plan:{cloudPlanHash:'plan-one',tasks}},
    onSettings(){},onDataInfo(){}};
  const Component=load('app/study-progress-overview.tsx').StudyProgressOverview;
  hooks.mount(Component,props);
  const card=()=>[...nodes(hooks.view())].find(node=>node.type==='article'&&node.props.className?.includes('c-progress-current'));
  const select=()=>[...nodes(card())].find(node=>node.type==='select');
  const ring=()=>[...nodes(card())].find(node=>node.props.role==='img');
  return{hooks,props,card,select,ring,read:()=>text(card()),render:next=>hooks.render(next??props),setView:value=>{planView=value;},
    choose(taskId){const input=select();assert.ok(input,'multi-task progress must expose its selected range');input.props.onChange({target:{value:taskId}});hooks.render();}};
}

test('real progress card names and switches task ranges without presenting one as the whole subject',()=>{
  const f=fixture();
  assert.ok(f.select());
  assert.equal(f.select().props['aria-label'],'选择进度任务范围');
  assert.match(f.read(),/新词学习.*今日新词/);
  assert.match(f.read(),/复习.*课程复习第二组/);
  f.choose('second');
  assert.match(f.read(),/当前任务：复习 · 课程复习第二组/);
  assert.equal(f.ring().props['aria-label'],'当前任务已完成 0 / 2 项');
  f.setView({phase:'ready',counts:{first:{completed:1,total:1},second:{completed:1,total:2}}});
  f.render();
  assert.equal(f.ring().props['aria-label'],'当前任务已完成 1 / 2 项');
  assert.match(f.read(),/已完成 1 项 \| 剩余 1 项/);
  f.hooks.unmount();
});

test('unknown task counts remain unknown even when the general stage cache is complete',()=>{
  const f=fixture();f.choose('second');
  for(const view of [null,{phase:'ready',counts:{}},{phase:'failed',counts:{second:{completed:2,total:2}}}]){
    f.setView(view);f.render();
    assert.equal(f.ring().props['aria-label'],'完成数量尚无可核对口径');
    assert.doesNotMatch(f.read(),/已完成 [0-9]+ 项 \| 剩余/);
  }
  f.hooks.unmount();
});

test('owner, library, plan and subject transitions reset the selected task range',()=>{
  const f=fixture();
  const changed=[
    {...f.props,accountPlan:{...f.props.accountPlan,workspaceId:'account:two'}},
    {...f.props,accountPlan:{...f.props.accountPlan,loaded:{bundle:{snapshot:{libraryId:'library-two'}}}}},
    {...f.props,accountPlan:{...f.props.accountPlan,plan:{...f.props.accountPlan.plan,cloudPlanHash:'plan-two'}}},
    {...f.props,activeId:'other',modules:[...f.props.modules,{id:'other',name:'其他课程',pluginType:'recall',itemKeys:[]}]},
  ];
  for(const next of changed){
    f.render(f.props);f.choose('second');f.render(next);f.render(next);f.render(f.props);f.render(f.props);
    assert.equal(f.select().props.value,'first');
  }
  f.hooks.unmount();
});

test('a single task is named without a selector and an unplanned subject retains its full range',()=>{
  const f=fixture();
  f.render({...f.props,accountPlan:{...f.props.accountPlan,plan:{...f.props.accountPlan.plan,tasks:[f.props.accountPlan.plan.tasks[0]]}}});
  assert.equal(f.select(),undefined);assert.match(f.read(),/当前任务：新词学习 · 今日新词/);
  f.render({...f.props,accountPlan:null,modules:[{...f.props.modules[0],pluginType:'three-stage'}]});
  assert.equal(f.select(),undefined);assert.match(f.read(),/当前范围：合成课程 3 词/);
  assert.equal(f.ring().props['aria-label'],'当前范围已完成 3 / 3 词');
  f.hooks.unmount();
});

test('the real plan progress hook hides previous counts until the new owner, library or plan is read',async()=>{
  const hooks=createHooks();
  const load=loader(hooks.api,{
    'app/study-submission-history.ts':{readAccountLocalPractice:async()=>({bundles:[],records:[]})},
    'app/account-study-planning-projection.ts':{accountTaskActivity:async()=>({itemProgressByTask:{first:{completed:1,total:1}}})},
  });
  const {useProgressPlanScope}=load('app/use-progress-plan-scope.ts');
  const initial={workspaceId:'account:one',loaded:{bundle:{snapshot:{libraryId:'library-one'}},catalogs:[{catalogHash:'catalog'}],bundles:[],records:[],eventThrough:1},
    plan:{catalogHash:'catalog',cloudPlanHash:'plan-one'},journal:{},revision:1};
  hooks.mount(({input})=>useProgressPlanScope(input),{input:initial});
  const settle=async()=>{hooks.flush();await tick();hooks.render();};
  await settle();assert.equal(hooks.view().counts.first.completed,1);
  for(const input of [
    {...initial,workspaceId:'account:two'},
    {...initial,loaded:{...initial.loaded,bundle:{snapshot:{libraryId:'library-two'}}}},
    {...initial,plan:{...initial.plan,cloudPlanHash:'plan-two'}},
  ]){
    hooks.render({input});assert.equal(hooks.view(),null,'old counts must be hidden before reading the new scope');
    await settle();assert.equal(hooks.view().phase,'ready');
    hooks.render({input:initial});assert.equal(hooks.view(),null);await settle();
  }
  hooks.unmount();
});
