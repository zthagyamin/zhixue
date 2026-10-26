import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {createHooks,loader,button,deferred,tick,text} from './helpers/causal-harness.mjs';

// Exercise the real caller's readiness wiring as well as the stateful component.
const caller=ts.createSourceFile('today-view.tsx',readFileSync(new URL('../app/study-dashboard/today-view.tsx',import.meta.url),'utf8'),ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
let attributes;
function visit(node){
  if(ts.isJsxSelfClosingElement(node)&&node.tagName.getText(caller)==='GeneratedPlanStart')attributes=node.attributes.properties;
  ts.forEachChild(node,visit);
}
visit(caller);
assert.ok(attributes,'the actual today page must contain the explicit start control');
function readiness(values){
  const result={};
  for(const name of ['disabled','loading']){
    const attribute=attributes.find(value=>ts.isJsxAttribute(value)&&value.name.getText(caller)===name);
    result[name]=attribute?.initializer?.expression
      ?new Function(...Object.keys(values),'return ('+attribute.initializer.expression.getText(caller)+');')(...Object.values(values))
      :false;
  }
  return result;
}
function fixture(){
  const hooks=createHooks(),wait=deferred(),starts=[];
  const Component=loader(hooks.api)('app/generated-plan-start.tsx').GeneratedPlanStart;
  let calls=0;
  const values={planLoading:false,storageReady:true,vocabPacingWorkspace:'owner-a',workspaceId:'owner-a',subjects:[{}]};
  const props={scope:'owner-a/library/day',hash:undefined,visible:true,generate:()=>{calls++;return wait.promise;},onStart:()=>starts.push(props.hash)};
  function render(){hooks.render({...props,...readiness(values)});hooks.flush();}
  hooks.mount(Component,{...props,...readiness(values)});hooks.flush();
  return {hooks,wait,starts,values,props,render,calls:()=>calls};
}
async function finish(f){
  f.values.planLoading=false;f.props.hash='new-plan';f.wait.resolve('new-plan');
  await tick();f.render();f.render();
}

test('first explicit start survives its own loading transition and starts the acknowledged plan once',async()=>{
  const f=fixture();
  const start=button(f.hooks.view(),'开始今日练习').props.onClick;
  start();start();
  f.values.planLoading=true;f.render();
  assert.equal(button(f.hooks.view(),'正在安排…').props.disabled,true);
  assert.equal(f.calls(),1);
  await finish(f);
  assert.deepEqual(f.starts,['new-plan']);
  assert.doesNotMatch(text(f.hooks.view()),/已经变化|重新开始/);
  f.render();assert.equal(f.starts.length,1);f.hooks.unmount();
});

for(const change of ['hidden','scope','storage','workspace']){
  test('pending start stays cancelled after '+change+' changes and recovers',async()=>{
    const f=fixture();button(f.hooks.view(),'开始今日练习').props.onClick();
    f.values.planLoading=true;f.render();
    if(change==='hidden')f.props.visible=false;
    if(change==='scope')f.props.scope='owner-b/library/day';
    if(change==='storage')f.values.storageReady=false;
    if(change==='workspace')f.values.vocabPacingWorkspace='owner-b';
    f.render();
    f.props.visible=true;f.props.scope='owner-a/library/day';
    f.values.storageReady=true;f.values.vocabPacingWorkspace='owner-a';f.render();
    await finish(f);assert.deepEqual(f.starts,[]);f.hooks.unmount();
  });
}

test('a replacement plan cannot start from an earlier generation acknowledgement',async()=>{
  const f=fixture();button(f.hooks.view(),'开始今日练习').props.onClick();
  f.wait.resolve('new-plan');await tick();f.props.hash='replacement-plan';f.render();
  assert.deepEqual(f.starts,[]);
  f.props.hash='new-plan';f.render();assert.deepEqual(f.starts,[]);f.hooks.unmount();
});

test('external generation blocks another start without creating a request',()=>{
  const f=fixture();f.values.planLoading=true;f.render();
  const start=button(f.hooks.view(),'开始今日练习');
  assert.equal(start.props.disabled,true);start.props.onClick();assert.equal(f.calls(),0);f.hooks.unmount();
});

test('an acknowledged plan waits for loading to finish before entering once',async()=>{
  const f=fixture();button(f.hooks.view(),'开始今日练习').props.onClick();
  f.values.planLoading=true;f.render();
  f.props.hash='new-plan';f.wait.resolve('new-plan');await tick();f.render();
  assert.deepEqual(f.starts,[]);
  f.values.planLoading=false;f.render();f.render();
  assert.deepEqual(f.starts,['new-plan']);f.hooks.unmount();
});

test('unmounting prevents a pending generation from entering learning',async()=>{
  const f=fixture();button(f.hooks.view(),'开始今日练习').props.onClick();
  f.hooks.unmount();f.wait.resolve('new-plan');await tick();assert.deepEqual(f.starts,[]);
});
