import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {createHooks} from './helpers/causal-harness.mjs';
import * as focus from '../src/features/workspace-ui/navigation-focus.ts';

test('keyboard entry and return use committed views without stealing focus on answer renders',()=>{
  const hooks=createHooks(),events=new Map(),frames=new Map();let serial=0,sessionAvailable=false,observed=null;
  const session={tabIndex:0,focused:0,scrolled:0,focus(){this.focused++;},scrollIntoView(){this.scrolled++;}};
  const details={tagName:'DETAILS',open:false,parentElement:null};
  class Control {
    constructor(key,parent=null){this.dataset={studyReturn:key};this.parentElement=parent;this.isConnected=true;this.focused=0;}
    closest(selector){return selector==='.study-app.app-shell'?root:selector==='button,a[href],summary'?this:null;}
    matches(){return false;}
    getClientRects(){return !this.parentElement||this.parentElement.open?[{}]:[];}
    focus(){this.focused++;document.activeElement=this;}
    scrollIntoView(){}
  }
  let controls=[];const today=new Control('today');
  const root={querySelectorAll:()=>controls,querySelector:selector=>selector==='.study-primary-session'?(sessionAvailable?session:null):selector==='[data-study-return="today"]'?today:null};
  const document={activeElement:{closest:()=>null},querySelector:selector=>selector==='dialog[open]'?null:root,
    addEventListener:(name,fn)=>events.set(name,fn),removeEventListener:name=>events.delete(name)};
  const raf=fn=>{const id=++serial;frames.set(id,fn);return id;},cancel=id=>frames.delete(id);
  const pump=()=>{const batch=[...frames.values()];frames.clear();batch.forEach(fn=>fn());};
  const source=readFileSync(new URL('../src/features/workspace-ui/navigation-focus-runtime.ts',import.meta.url),'utf8');
  const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  class Observer {constructor(fn){observed=fn;}observe(){}disconnect(){observed=null;}}
  const exports={};new Function('require','exports','document','requestAnimationFrame','cancelAnimationFrame','Element','MutationObserver',compiled)(
    name=>name==='react'?hooks.api:focus,exports,document,raf,cancel,Control,Observer);
  const useFocus=exports.useStudyNavigationFocus;
  hooks.mount(props=>{useFocus(props.scope,props.identity,props.page);return null;},{scope:'account-a/library-a',identity:null,page:'today'});hooks.flush();
  const old=new Control('nav:words',details);controls=[old,today];events.get('focusin')({target:old});
  hooks.render({scope:'account-a/library-a',identity:'words/task-1',page:'words'});hooks.flush();pump();
  assert.equal(session.focused,0,'lazy loading must not focus an empty workspace');assert.equal(typeof observed,'function');
  sessionAvailable=true;observed();pump();
  assert.equal(session.focused,1);assert.equal(session.scrolled,1);assert.equal(session.tabIndex,-1);
  // Saving failed or editing an answer leaves the committed identity unchanged.
  document.activeElement={closest:()=>({tagName:'TEXTAREA'})};hooks.render();hooks.flush();pump();
  assert.equal(session.focused,1);
  document.activeElement={closest:()=>null};hooks.render({scope:'account-a/library-a',identity:'words/task-2',page:'words'});hooks.flush();pump();
  assert.equal(session.focused,2,'explicitly changing the learning object refocuses once');
  old.isConnected=false;const rebuilt=new Control('nav:words',details);controls=[rebuilt,today];
  hooks.render({scope:'account-a/library-a',identity:null,page:'today'});hooks.flush();pump();
  assert.equal(details.open,true);assert.equal(rebuilt.focused,1);assert.equal(old.focused,0);
  hooks.unmount();assert.equal(events.size,0);assert.equal(frames.size,0);
});
