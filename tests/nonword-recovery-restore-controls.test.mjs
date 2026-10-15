import test from 'node:test';
import assert from 'node:assert/strict';
import {createHooks,loader,nodes,text,button,deferred,tick} from './helpers/causal-harness.mjs';

const owner='account:synthetic-a';
const pack={schemaVersion:2,workspaceId:owner,payload:{nonword:{marker:'original bytes'}}};
const raw='  '+JSON.stringify(pack)+'\n';
const preview={schemaVersion:1,workspaceId:owner,packageHash:'package',previewHash:'preview-1',restorable:3,existing:2,conflicts:1,review:4,decisions:[]};
const receipt={status:'partial',restored:3,existing:2,conflicts:1,review:4,archiveHash:'archive'};
function fixture(overrides={}){
  const hooks=createHooks(),calls={preview:[],restore:[],archives:[],changed:0};
  const service={
    async previewNonwordRestore(...args){calls.preview.push(args);return preview;},
    async restoreNonwordBackup(...args){calls.restore.push(args);return receipt;},
    async readRecoveryArchives(...args){calls.archives.push(args);return [];},...overrides,
  };
  const Component=loader(hooks.api)('src/features/nonword-recovery/restore-controls.tsx').NonwordRecoveryRestore;
  const port={preview:service.previewNonwordRestore,restore:service.restoreNonwordBackup,archives:service.readRecoveryArchives};
  let props={workspaceId:owner,ready:true,port,onChanged:()=>{calls.changed++;}};
  hooks.mount(Component,props);hooks.flush();
  const render=next=>{props={...props,...next};return hooks.render(props);};
  const settle=async()=>{await tick();render();hooks.flush();};
  const input=()=>[...nodes(hooks.view())].find(n=>n.type==='input'&&n.props.type==='file');
  const choose=file=>input().props.onChange({currentTarget:{files:[file],value:'selected'}});
  const file={name:'backup.json',size:raw.length,text:async()=>raw};
  return {hooks,calls,render,settle,input,choose,file,view:hooks.view};
}
test('actual controls preview counts, preserve package and show partial restore without claiming grades',async()=>{
  const f=fixture();f.choose(f.file);await f.settle();
  assert.match(text(f.view()),/可恢复 3 条/);assert.match(text(f.view()),/已有 2 条/);
  assert.match(text(f.view()),/冲突 1 条/);assert.match(text(f.view()),/待核对 4 条/);
  button(f.view(),'恢复可核对的记录').props.onClick();await f.settle();
  assert.deepEqual(f.calls.preview[0].slice(0,2),[owner,pack]);
  assert.deepEqual(f.calls.restore[0].slice(0,3),[owner,pack,'preview-1']);
  assert.match(text(f.view()),/已恢复 3 条记录/);assert.match(text(f.view()),/非词汇备份副本已保留/);
  assert.match(text(f.view()),/待核对/);assert.equal(f.calls.changed,1);
  assert.equal(button(f.view(),'恢复可核对的记录').props.disabled,true);
});
test('same-tick repeated restore clicks perform one save and one refresh callback',async()=>{
  const save=deferred();let saves=0;const f=fixture({restoreNonwordBackup:async()=>{saves++;return save.promise;}});
  f.choose(f.file);await f.settle();const click=button(f.view(),'恢复可核对的记录').props.onClick;
  click();click();assert.equal(saves,1);save.resolve(receipt);await f.settle();assert.equal(f.calls.changed,1);
});
test('owner changes invalidate preview before effects and returning to old owner does not revive it',async()=>{
  const pending=deferred();let options;const f=fixture({previewNonwordRestore:async(_owner,_raw,guard)=>{options=guard;return pending.promise;}});
  f.choose(f.file);await tick();f.render({workspaceId:'account:synthetic-b'});
  assert.equal(options.current(),false);assert.doesNotMatch(text(f.view()),/backup.json/);
  f.render({workspaceId:owner});pending.resolve(preview);await f.settle();
  assert.doesNotMatch(text(f.view()),/可恢复 3 条/);assert.equal(f.calls.changed,0);
});
test('late file read and old event handlers cannot submit to a new owner',async()=>{
  const read=deferred();const f=fixture();const oldChoose=f.input().props.onChange;
  f.choose({...f.file,text:()=>read.promise});f.render({workspaceId:'account:synthetic-b'});
  read.resolve(raw);await f.settle();assert.equal(f.calls.preview.length,0);
  oldChoose({currentTarget:{files:[f.file],value:''}});await f.settle();assert.equal(f.calls.preview.length,0);
});
test('ready loss and unmount invalidate service guards without publishing late restore',async()=>{
  for(const stop of ['ready','unmount']){
    const saved=deferred();let guard;const f=fixture({restoreNonwordBackup:async(_owner,_pack,_hash,options)=>{guard=options;return saved.promise;}});
    f.choose(f.file);await f.settle();button(f.view(),'恢复可核对的记录').props.onClick();
    if(stop==='ready'){f.render({ready:false});assert.equal(f.input().props.disabled,true);}else f.hooks.unmount();
    assert.equal(guard.current(),false);saved.resolve(receipt);await tick();assert.equal(f.calls.changed,0);
  }
});
test('failed save retains preview and parsed bytes for retry without rereading file',async()=>{
  let saves=0,reads=0;const seen=[];const f=fixture({restoreNonwordBackup:async(...args)=>{seen.push(args);if(++saves===1)throw Error('private error payload');return {...receipt,status:'restored',conflicts:0,review:0};}});
  f.choose({...f.file,text:async()=>{reads++;return raw;}});await f.settle();
  button(f.view(),'恢复可核对的记录').props.onClick();await f.settle();
  assert.match(text(f.view()),/未完成/);assert.doesNotMatch(text(f.view()),/private error payload/);
  assert.equal(button(f.view(),'恢复可核对的记录').props.disabled,false);
  button(f.view(),'恢复可核对的记录').props.onClick();await f.settle();
  assert.equal(reads,1);assert.deepEqual(seen[0].slice(0,3),seen[1].slice(0,3));assert.equal(f.calls.changed,1);
});
test('stale preview asks for repreview using retained bytes and updated hash',async()=>{
  let reads=0,previews=0;const f=fixture({
    previewNonwordRestore:async()=>({...preview,previewHash:'preview-'+(++previews)}),
    restoreNonwordBackup:async()=>{throw Error('本机记录已变化，请重新预览后恢复。');},
  });
  f.choose({...f.file,text:async()=>{reads++;return raw;}});await f.settle();
  button(f.view(),'恢复可核对的记录').props.onClick();await f.settle();
  assert.match(text(f.view()),/重新预览/);assert.equal(button(f.view(),'恢复可核对的记录').props.disabled,true);
  button(f.view(),'重新预览备份').props.onClick();await f.settle();
  assert.equal(reads,1);assert.equal(previews,2);assert.equal(button(f.view(),'恢复可核对的记录').props.disabled,false);
});
test('file validation rejects non-json and over-32MB before reading, while local mode stays disabled',async()=>{
  const f=fixture();let reads=0;
  for(const file of [{name:'backup.txt',size:1},{name:'backup.json',size:32*1024*1024+1}]){
    f.choose({...file,text:async()=>{reads++;return raw;}});await f.settle();assert.match(text(f.view()),/32 MB/);
  }
  assert.equal(reads,0);assert.equal(f.calls.preview.length,0);f.render({workspaceId:'local'});
  assert.equal(f.input().props.disabled,true);f.choose(f.file);await f.settle();assert.equal(f.calls.preview.length,0);
});
test('archive evidence is bounded plain text and labels unverified answers without active HTML',async()=>{
  const dangerous='<img src=x onerror=alert(1)> https://example.invalid/source';
  const f=fixture({readRecoveryArchives:async()=>[{sourceHash:'archive',source:{databases:[{kind:'attempts',stores:{attempts:[{attempt:{submitted:{answer:dangerous},evaluation:{feedback:'untrusted grade'},formal:{rating:'easy'}}}]}},{kind:'native-course',stores:{captures:[{source:{text:'Original source snippet'}}]}}]}}]});
  button(f.view(),'查看保留的原备份').props.onClick();await f.settle();
  assert.match(text(f.view()),/待核对/);assert.match(text(f.view()),/Original source snippet/);assert.ok(text(f.view()).includes(dangerous));
  assert.doesNotMatch(text(f.view()),/untrusted grade/);
  assert.equal([...nodes(f.view())].some(n=>n.type==='a'||n.type==='img'||n.props.dangerouslySetInnerHTML),false);
});
test('late archive response cannot show another account raw answers',async()=>{
  const archive=deferred();const f=fixture({readRecoveryArchives:async()=>archive.promise});
  button(f.view(),'查看保留的原备份').props.onClick();f.render({workspaceId:'account:synthetic-b'});
  archive.resolve([{sourceHash:'archive',source:{databases:[{stores:{records:[{answer:'OTHER ACCOUNT ANSWER'}]}}]}}]);
  await f.settle();assert.doesNotMatch(text(f.view()),/OTHER ACCOUNT ANSWER/);
});
