import assert from 'node:assert/strict';
import test from 'node:test';
import {readDashboardSource} from './helpers/dashboard-source.mjs';
let api;
try { api=await import('../app/study-theme.ts'); } catch(error) { if(error.code!=='ERR_MODULE_NOT_FOUND')throw error; }

test('theme selection survives a new page store without touching learning storage',()=>{
  assert.equal(typeof api?.createStudyThemePreference,'function');
  const values=new Map(),writes=[];
  const storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>{values.set(key,value);writes.push(key);}};
  const first=api.createStudyThemePreference(()=>storage);
  assert.equal(first.getSnapshot(),'light');
  let notices=0;const unsubscribe=first.subscribe(()=>notices++);
  first.set('dark');assert.equal(first.getSnapshot(),'dark');assert.equal(notices,1);
  assert.equal(api.createStudyThemePreference(()=>storage).getSnapshot(),'dark');
  unsubscribe();first.set('light');assert.equal(notices,1);
  assert.deepEqual(writes,['zhixue:appearance:theme:v1','zhixue:appearance:theme:v1']);
});

test('unavailable preference storage never prevents in-page theme switching',()=>{
  assert.equal(typeof api?.createStudyThemePreference,'function');
  for(const getStorage of [()=>{throw new Error('storage-unavailable');},()=>({getItem:()=>null,setItem(){throw new Error('quota');}})]){
    const store=api.createStudyThemePreference(getStorage);assert.equal(store.getSnapshot(),'light');
    store.set('dark');assert.equal(store.getSnapshot(),'dark');
  }
});

test('unknown stored themes keep the approved light default and server markup stays deterministic',async()=>{
  assert.equal(typeof api?.createStudyThemePreference,'function');
  assert.equal(api.createStudyThemePreference(()=>({getItem:()=>'<unknown>',setItem(){}})).getSnapshot(),'light');
  const source=await readDashboardSource();
  assert.match(source,/useSyncExternalStore\(studyThemePreference\.subscribe,studyThemePreference\.getSnapshot,serverStudyTheme\)/);
  assert.equal(api.serverStudyTheme(),'light');
});
