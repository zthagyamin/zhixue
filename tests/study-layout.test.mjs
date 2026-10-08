import assert from 'node:assert/strict';
import {test} from 'node:test';
import {layoutMediaQuery,createLayoutPreference,applyStudyLayout} from '../app/study-layout.ts';
test('manual layouts evaluate width breakpoints while retaining real accessibility preferences',()=>{
  assert.equal(layoutMediaQuery('(max-width: 640px)','desktop'),'(width: 0px)');
  assert.equal(layoutMediaQuery('(max-width: 640px)','mobile'),'(min-width: 0px)');
  assert.equal(layoutMediaQuery('(width >= 48rem) and (prefers-reduced-motion: reduce)','tablet'),'(min-width: 0px) and (prefers-reduced-motion: reduce)');
  assert.equal(layoutMediaQuery('(min-width: 881px) and (max-width: 1100px)','tablet'),'(min-width: 0px) and (min-width: 0px)');
  assert.equal(layoutMediaQuery('(max-width: 640px)','auto'),'(max-width: 640px)');
});
test('lazy stylesheet conditions are handled and automatic mode restores every original condition',()=>{
  const originalObserver=globalThis.MutationObserver;let changed;globalThis.MutationObserver=class{constructor(callback){changed=callback;}observe(){}disconnect(){}};
  const frames=[],media={mediaText:'(max-width: 640px)'},nested={mediaText:'(width >= 48rem)'},sheets=[{media:{mediaText:''},cssRules:[{media,cssRules:[{media:nested,cssRules:[]}]}]}];
  const listeners=new Map(),document={head:{},documentElement:{dataset:{}},styleSheets:sheets,defaultView:{requestAnimationFrame:fn=>(frames.push(fn),frames.length),cancelAnimationFrame(){}},addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:name=>listeners.delete(name)};
  try{
    const restore=applyStudyLayout(document,'desktop');assert.equal(media.mediaText,'(width: 0px)');assert.equal(nested.mediaText,'(min-width: 0px)');
    const later={mediaText:'(max-width: 900px) and (prefers-reduced-motion: reduce)'};sheets.push({media:{mediaText:''},cssRules:[{media:later,cssRules:[]}]});changed();frames.shift()();assert.equal(later.mediaText,'(width: 0px) and (prefers-reduced-motion: reduce)');
    restore();assert.equal(media.mediaText,'(max-width: 640px)');assert.equal(nested.mediaText,'(width >= 48rem)');assert.equal(later.mediaText,'(max-width: 900px) and (prefers-reduced-motion: reduce)');assert.equal(document.documentElement.dataset.studyLayout,undefined);assert.equal(listeners.size,0);
  }finally{globalThis.MutationObserver=originalObserver;}
});
test('layout choices remain local to the browser and survive storage failures',()=>{
  const values=new Map();const pref=createLayoutPreference(()=>({getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)}));
  assert.equal(pref.getSnapshot(),'auto');pref.set('desktop');assert.equal(pref.getSnapshot(),'desktop');
  assert.equal(createLayoutPreference(()=>({getItem:k=>values.get(k)??null,setItem(){}})).getSnapshot(),'desktop');
  const blocked=createLayoutPreference(()=>{throw Error('blocked');});blocked.set('mobile');assert.equal(blocked.getSnapshot(),'mobile');
});
