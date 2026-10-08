import assert from 'node:assert/strict';
import test from 'node:test';
import {tsxFunction} from './fixtures/tsx-functions.mjs';
import {createLearningDraftStore} from '../app/learning-draft-store.ts';
const file=new URL('../app/assistance-display.tsx',import.meta.url);
function fixture(){const draft=createLearningDraftStore().adapter('item','quiz:1'),observer=draft.assistance;observer.cover();const document=new EventTarget();document.visibilityState='visible';return{observer,document};}
function effect(env){const run=tsxFunction(file,'useAssistanceDisplay',env,{effect:true});assert.equal(typeof run,'function','Visible assistance hook must exist');return run();}
test('only a rendered aid in a visible document is counted, once across repeated effects',()=>{
  const f=fixture(),env={...f,action:'ai-hint',displayId:'reply-one',active:true};const a=effect(env),b=effect(env);a?.();b?.();
  assert.deepEqual(f.observer.snapshot().preSubmitAssistance,[{action:'ai-hint',count:1}]);
});
test('a response rendered in a background tab is counted when that tab becomes visible',()=>{
  const f=fixture();f.document.visibilityState='hidden';const cleanup=effect({...f,action:'ai-tutor',displayId:'reply-one',active:true});
  f.observer.submit();f.document.visibilityState='visible';f.document.dispatchEvent(new Event('visibilitychange'));cleanup?.();
  assert.deepEqual(f.observer.snapshot().postSubmitFeedback,[{action:'ai-tutor',count:1}]);
});
test('unmounting before a background result becomes visible never counts that result',()=>{
  const f=fixture();f.document.visibilityState='hidden';const cleanup=effect({...f,action:'ai-tutor',displayId:'reply-one',active:true});cleanup?.();
  f.document.visibilityState='visible';f.document.dispatchEvent(new Event('visibilitychange'));assert.deepEqual(f.observer.snapshot().preSubmitAssistance,[]);
});
test('empty or hidden response branches do not count a successful request as shown',()=>{
  for(const input of [{active:false,displayId:'reply-one'},{active:true,displayId:null}]){const f=fixture();effect({...f,...input,action:'ai-hint'});assert.deepEqual(f.observer.snapshot().preSubmitAssistance,[]);}
});
