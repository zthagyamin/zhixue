import test from 'node:test';
import assert from 'node:assert/strict';
import {createHooks,loader,nodes,text,button,deferred,tick} from './helpers/causal-harness.mjs';
import {createVaultMappingClient} from '../app/vault-mapping-client.ts';

const contextId='a'.repeat(64),previewId='b'.repeat(32);
const rule={pathGlob:'Courses/**/*.md',subjectId:'mapped:synthetic',subjectLabel:'Synthetic',contentKind:'quiz',splitMode:'heading',headingLevel:2};
const inspection={schemaVersion:2,contextId,revision:1,rules:[rule],suggestions:[rule],sampledFiles:1,sampleLimit:20,confidence:1,ambiguous:false,active:false};
const proof={schemaVersion:2,contextId,previewId,revision:1,itemCount:1,items:[{id:'synthetic-item',prompt:'Synthetic preview',answer:'Synthetic answer',sourceNote:'Synthetic.md'}]};
function fixture(overrides={}){
  const calls=[],changes=[],client={inspect:async()=>inspection,preview:async(...args)=>{calls.push(['preview',...args]);return proof;},save:async(...args)=>{calls.push(['save',...args]);return {...inspection,revision:2};},...overrides};
  const hooks=createHooks(),load=loader(hooks.api,{'app/study-session-shell.tsx':{StudyPanel:()=>null}});
  const Component=load('app/vault-mapping-panel.tsx').VaultMappingPanel,props={client,onChanged:()=>changes.push('changed')};
  hooks.mount(Component,props);hooks.flush();
  return {hooks,client,props,calls,changes,view:hooks.view,button:label=>button(hooks.view(),label),async click(label){const node=button(hooks.view(),label);assert.ok(node,label);assert.ok(!node.props.disabled,label+' enabled');node.props.onClick();await tick();hooks.render();hooks.flush();hooks.render();},async settle(){await tick();hooks.render();hooks.flush();hooks.render();}};
}
async function opened(overrides){const f=fixture(overrides);await f.click('读取并设置映射');return f;}
test('actual panel submits inspected context and exact preview proof, preserving source presentation',async()=>{
  const f=await opened();await f.click('预览提取结果');
  assert.deepEqual(f.calls[0],['preview',[rule],contextId]);assert.match(text(f.view()),/Synthetic answerSynthetic.md/);
  await f.click('确认并保存 1 条规则');assert.deepEqual(f.calls[1],['save',[rule],1,proof]);assert.deepEqual(f.changes,['changed']);f.hooks.unmount();
});
test('lost committed save response retains the exact proof for a receipt retry',async()=>{
  let attempts=0;const received=[];
  const f=await opened({save:async(...args)=>{
    received.push(args);attempts++;
    if(attempts===1)throw Error('Synthetic response lost after commit');
    return {...inspection,revision:2};
  }});
  await f.click('预览提取结果');await f.click('确认并保存 1 条规则');
  assert.match(text(f.view()),/Synthetic response lost after commit/);assert.deepEqual(f.changes,[]);
  assert.ok(f.button('确认并保存 1 条规则'),'uncertain save retains confirmation');
  await f.click('确认并保存 1 条规则');
  assert.deepEqual(received,[[[rule],1,proof],[[rule],1,proof]]);assert.equal(received[0][2],received[1][2]);
  assert.deepEqual(f.changes,['changed']);assert.ok(!f.button('确认并保存 1 条规则'));f.hooks.unmount();
});
test('a newer preview confirms its revision even when the inspection revision is older',async()=>{
  const newerProof={...proof,revision:2,previewId:'c'.repeat(32)},f=await opened({preview:async(...args)=>{f.calls.push(['preview',...args]);return newerProof;}});
  await f.click('预览提取结果');await f.click('确认并保存 1 条规则');
  assert.deepEqual(f.calls[1],['save',[rule],2,newerProof]);assert.deepEqual(f.changes,['changed']);f.hooks.unmount();
});
test('actual client and panel retry the committed receipt and accept a newer preview revision',async()=>{
  const requests=[];let revision=1,lost=true;
  const client=createVaultMappingClient({companionUrl:'http://127.0.0.1:8765',sessionToken:'synthetic-pair',fetcher:async(_url,init)=>{
    if(init.method==='GET')return Response.json(inspection);
    const body=JSON.parse(init.body);requests.push(body);
    if(body.action==='preview')return Response.json({...proof,revision,previewId:revision===1?previewId:'c'.repeat(32)});
    if(body.previewId===previewId){revision=2;if(lost){lost=false;throw Error('Synthetic response lost after commit');}}
    else revision++;
    return Response.json({...inspection,revision});
  }});
  const f=await opened(client);await f.click('预览提取结果');await f.click('确认并保存 1 条规则');
  assert.deepEqual(f.changes,[]);await f.click('确认并保存 1 条规则');
  const confirms=requests.filter(body=>body.action==='confirm');assert.deepEqual(confirms[0],confirms[1]);assert.equal(confirms[0].revision,1);assert.equal(confirms[0].previewId,previewId);
  revision=3; // Another operation advances the server after the last inspection/save.
  await f.click('预览提取结果');await f.click('确认并保存 1 条规则');
  assert.equal(requests.at(-1).revision,3);assert.equal(requests.at(-1).previewId,'c'.repeat(32));assert.deepEqual(f.changes,['changed','changed']);f.hooks.unmount();
});
test('client swap synchronously hides rules and preview, and returning never revives them',async()=>{
  for(const replacement of [null,{inspect:async()=>inspection,preview:async()=>proof,save:async()=>inspection}]){
    const f=await opened();await f.click('预览提取结果');
    f.hooks.render({...f.props,client:replacement});assert.ok(!f.button('确认并保存 1 条规则'));assert.ok(!text(f.view()).includes('Synthetic preview'));
    f.hooks.render(f.props);assert.ok(!f.button('确认并保存 1 条规则'));assert.equal([...nodes(f.view())].filter(n=>n.type==='fieldset').length,0);f.hooks.unmount();
  }
});
test('retired client result cannot clear a replacement client operation or replace its rules',async()=>{
  const old=deferred(),next=deferred(),f=await opened({preview:()=>old.promise});f.button('预览提取结果').props.onClick();
  const replacement={inspect:()=>next.promise,preview:async()=>proof,save:async()=>inspection};
  f.hooks.render({...f.props,client:replacement});f.button('读取并设置映射').props.onClick();
  old.resolve(proof);await f.settle();assert.equal(f.button('读取并设置映射').props.disabled,true);assert.ok(!text(f.view()).includes('Synthetic preview'));
  next.resolve({...inspection,rules:[{...rule,subjectLabel:'Replacement'}]});await f.settle();
  assert.equal(f.button('读取并设置映射').props.disabled,false);assert.ok([...nodes(f.view())].some(n=>n.type==='input'&&n.props.value==='Replacement'));f.hooks.unmount();
});
for(const action of ['read','preview','save'])test(`late ${action} success and failure cannot update replacement client before effects`,async()=>{
  for(const rejects of [false,true]){
    const wait=deferred(),overrides=action==='read'?{inspect:()=>wait.promise}:action==='preview'?{preview:()=>wait.promise}:{save:()=>wait.promise};
    const f=action==='read'?fixture(overrides):await opened(overrides);if(action==='save')await f.click('预览提取结果');
    const label=action==='read'?'读取并设置映射':action==='preview'?'预览提取结果':'确认并保存 1 条规则';
    f.button(label).props.onClick();f.hooks.render({...f.props,client:null});f.hooks.render(f.props);
    if(rejects)wait.reject(Error('STALE FAILURE'));else wait.resolve(action==='preview'?{...proof,items:[{id:'late',prompt:'STALE PREVIEW',sourceNote:'old.md'}]}:inspection);
    await f.settle();assert.ok(!text(f.view()).includes('STALE'));assert.ok(!f.button('确认并保存 1 条规则'));assert.equal([...nodes(f.view())].filter(n=>n.type==='fieldset').length,0);assert.deepEqual(f.changes,[]);f.hooks.unmount();
  }
});
test('same-tick repeated read, preview and confirm launch exactly one operation each',async()=>{
  const wait=deferred();let reads=0;const f=fixture({inspect:()=>{reads++;return wait.promise;}});
  const read=f.button('读取并设置映射').props.onClick;read();read();assert.equal(reads,1);wait.resolve(inspection);await f.settle();
  const pending=deferred();f.client.preview=(...args)=>{f.calls.push(['preview',...args]);return pending.promise;};
  const preview=f.button('预览提取结果').props.onClick;preview();preview();assert.equal(f.calls.length,1);pending.resolve(proof);await f.settle();
  const saved=deferred();f.client.save=(...args)=>{f.calls.push(['save',...args]);return saved.promise;};
  const confirm=f.button('确认并保存 1 条规则').props.onClick;confirm();confirm();assert.equal(f.calls.length,2);saved.resolve({...inspection,revision:2});await f.settle();assert.deepEqual(f.changes,['changed']);f.hooks.unmount();
});
for(const change of ['edit','remove','add','suggestions','reread'])test(`pending preview cannot reappear after ${change}`,async()=>{
  const wait=deferred(),f=await opened({preview:()=>wait.promise});
  const stalePreview=f.button('预览提取结果').props.onClick;stalePreview();
  if(change==='edit')[...nodes(f.view())].find(n=>n.type==='input').props.onChange({target:{value:'Updated/**/*.md'}});
  else if(change==='remove')f.button('移除规则 1').props.onClick();
  else if(change==='add')f.button('添加规则').props.onClick();
  else if(change==='suggestions')f.button('将抽样建议放入待预览规则').props.onClick();
  else f.button('读取并设置映射').props.onClick();
  wait.resolve(proof);await f.settle();assert.ok(!f.button('确认并保存 1 条规则'));assert.ok(!f.button('确认并保存 2 条规则'));assert.ok(!text(f.view()).includes('Synthetic preview'));f.hooks.unmount();
});
test('reread immediately clears old preview and rules; old confirmation handler cannot save',async()=>{
  const f=await opened();await f.click('预览提取结果');const confirm=f.button('确认并保存 1 条规则').props.onClick;
  const wait=deferred();f.client.inspect=()=>wait.promise;f.button('读取并设置映射').props.onClick();f.hooks.render();
  assert.equal([...nodes(f.view())].filter(n=>n.type==='fieldset').length,0);assert.ok(!f.button('确认并保存 1 条规则'));confirm();assert.equal(f.calls.filter(call=>call[0]==='save').length,0);
  wait.resolve({...inspection,rules:[]});await f.settle();f.hooks.unmount();
});
for(const change of ['edit','remove','add','suggestions'])test(`existing proof and retained confirmation handler are invalidated by ${change}`,async()=>{
  const f=await opened();await f.click('预览提取结果');const confirm=f.button('确认并保存 1 条规则').props.onClick;
  if(change==='edit')[...nodes(f.view())].find(n=>n.type==='input').props.onChange({target:{value:'Updated/**/*.md'}});
  else if(change==='remove')f.button('移除规则 1').props.onClick();
  else if(change==='add')f.button('添加规则').props.onClick();
  else f.button('将抽样建议放入待预览规则').props.onClick();
  confirm();await f.settle();assert.equal(f.calls.filter(call=>call[0]==='save').length,0);assert.ok(!text(f.view()).includes('Synthetic preview'));f.hooks.unmount();
});
test('closing or unmounting retires pending preview and its error',async()=>{
  for(const action of ['close','unmount']){
    const wait=deferred(),f=await opened({preview:()=>wait.promise});f.button('预览提取结果').props.onClick();
    if(action==='close')[...nodes(f.view())].find(node=>node.props.title==='学习库资料映射').props.onClose();else f.hooks.unmount();
    wait.reject(Error('STALE FAILURE'));await f.settle();assert.ok(!text(f.view()).includes('STALE FAILURE'));assert.deepEqual(f.changes,[]);f.hooks.unmount();
  }
});
