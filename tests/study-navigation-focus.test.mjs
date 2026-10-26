import test from 'node:test';
import assert from 'node:assert/strict';
import {createStudyNavigationFocus,restoreStudyReturnFocus} from '../src/features/workspace-ui/navigation-focus.ts';

test('focus changes only on completed study transitions and preserves the initial semantic entrance',()=>{
  const focus=createStudyNavigationFocus(),entry={key:'library:words',node:null};
  assert.equal(focus.transition('account-a/library-a',null,'today').kind,'none');
  focus.remember('account-a/library-a',entry);
  // A canceled leave or an unsuccessful save never changes the displayed identity.
  assert.equal(focus.transition('account-a/library-a',null,'today').kind,'none');
  assert.equal(focus.transition('account-a/library-a','words/task-1','words').kind,'enter');
  for(let n=0;n<3;n++)assert.equal(focus.transition('account-a/library-a','words/task-1','words').kind,'none','answer/input renders must not refocus');
  focus.remember('account-a/library-a',{key:'nav:other',node:null});
  assert.equal(focus.transition('account-a/library-a','other/task-2','other').kind,'enter');
  assert.deepEqual(focus.transition('account-a/library-a',null,'today'),{kind:'return',entry});
});

test('changing account or library discards the old return position',()=>{
  const focus=createStudyNavigationFocus();focus.transition('a/one',null,'today');
  focus.remember('a/one',{key:'library:private-a',node:null});focus.transition('a/one','words','words');
  assert.equal(focus.transition('b/two',null,'today').kind,'none');
  focus.remember('b/two',{key:'library:current-b',node:null});
  focus.remember('a/one',{key:'library:stale-a',node:null});
  focus.transition('b/two','words','words');
  assert.deepEqual(focus.transition('b/two',null,'today'),{kind:'return',entry:{key:'library:current-b',node:null}});
});

function target(key,{visible=true,details=null}={}){
  return {dataset:{studyReturn:key},isConnected:true,disabled:false,focused:0,scrolled:0,parentElement:details,
    getClientRects:()=>visible||details?.open?[{}]:[],focus(){this.focused++;},scrollIntoView(){this.scrolled++;},
    closest:()=>null};
}
test('return resolves rebuilt list controls and reopens a subject disclosure before focusing',()=>{
  const details={tagName:'DETAILS',open:false,parentElement:null};
  const rebuilt=target('nav:words',{visible:false,details}),old=target('nav:words');old.isConnected=false;
  const fallback=target('today');const doc={querySelectorAll:()=>[rebuilt,fallback],querySelector:()=>fallback};
  assert.equal(restoreStudyReturnFocus(doc,{key:'nav:words',node:old}),true);
  assert.equal(details.open,true);assert.equal(rebuilt.focused,1);assert.equal(old.focused,0);
  const list=target('library:words');doc.querySelectorAll=()=>[list,fallback];
  assert.equal(restoreStudyReturnFocus(doc,{key:'library:words',node:null}),true);assert.equal(list.focused,1);
});
test('a removed entrance uses the current Today control, never a disconnected element',()=>{
  const old=target('library:removed');old.isConnected=false;
  const fallback=target('today'),doc={querySelectorAll:()=>[fallback],querySelector:()=>fallback};
  assert.equal(restoreStudyReturnFocus(doc,{key:'library:removed',node:old}),true);
  assert.equal(fallback.focused,1);assert.equal(old.focused,0);
});
test('a completed task returns to its group control when its start button is disabled',()=>{
  const done=target('task:done');done.disabled=true;
  const group=target('group:words'),today=target('today');
  const doc={querySelectorAll:()=>[done,group,today],querySelector:()=>today};
  assert.equal(restoreStudyReturnFocus(doc,{key:'task:done',node:null,fallbackKey:'group:words'}),true);
  assert.equal(group.focused,1);assert.equal(done.focused,0);assert.equal(today.focused,0);
});
test('a rebuilt library entry expands its collapsed group before focusing the original control',()=>{
  const group={tagName:'DIV',id:'rebuilt-group',hidden:true,parentElement:null};
  const entry=target('library:words',{visible:false});entry.parentElement=group;
  entry.getClientRects=()=>group.hidden?[]:[{}];
  const toggle={getAttribute:name=>name==='aria-controls'?'rebuilt-group':group.hidden?'false':'true',click(){group.hidden=false;}};
  const today=target('today'),doc={querySelectorAll:selector=>selector==='[aria-controls]'?[toggle]:[entry,today],querySelector:()=>today};
  const origin={key:'library:words',node:null};
  assert.equal(restoreStudyReturnFocus(doc,origin),false);assert.equal(entry.focused,0);
  assert.equal(restoreStudyReturnFocus(doc,origin),true);assert.equal(entry.focused,1);assert.equal(today.focused,0);
});
