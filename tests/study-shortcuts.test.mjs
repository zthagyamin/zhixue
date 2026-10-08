import test from 'node:test';import assert from 'node:assert/strict';import {handleStudyShortcut} from '../app/study-shortcuts.ts';
function fixture(){let clicks=0,prevented=0;const button={disabled:false,getClientRects:()=>[{}],click:()=>clicks++},root={getClientRects:()=>[{}],closest:()=>null,ownerDocument:{querySelector:()=>null},querySelector:selector=>selector.includes('"1"')?button:null},event={key:'1',target:{closest:()=>null},preventDefault:()=>prevented++};return {root,event,button,counts:()=>[clicks,prevented]};}
test('numeric shortcut invokes the existing enabled button action once',()=>{const f=fixture();assert.equal(handleStudyShortcut(f.event,f.root),true);assert.deepEqual(f.counts(),[1,1]);});
test('typing, modal focus, modifiers and held keys never submit an answer',()=>{
 for(const patch of [{repeat:true},{isComposing:true},{ctrlKey:true},{metaKey:true},{altKey:true},{shiftKey:true},{defaultPrevented:true},{key:'Enter'},{key:' '},{target:{closest:()=>({})}}]){const f=fixture();assert.equal(handleStudyShortcut({...f.event,...patch},f.root),false);assert.deepEqual(f.counts(),[0,0]);}
 const f=fixture();f.root.ownerDocument.querySelector=()=>({});assert.equal(handleStudyShortcut(f.event,f.root),false);
});
test('hidden exercise, missing key and disabled control cannot be activated',()=>{const f=fixture();f.button.disabled=true;assert.equal(handleStudyShortcut(f.event,f.root),false);f.button.disabled=false;f.root.getClientRects=()=>[];assert.equal(handleStudyShortcut(f.event,f.root),false);assert.equal(handleStudyShortcut(f.event,null),false);});
test('Space and Enter require explicit actions and leave native interactive focus alone',()=>{
 for(const key of [' ','Enter']){const f=fixture();f.root.querySelector=()=>f.button;assert.equal(handleStudyShortcut({...f.event,key},f.root),true);assert.deepEqual(f.counts(),[1,1]);
 const native=fixture();native.root.querySelector=()=>native.button;assert.equal(handleStudyShortcut({...native.event,key,target:{closest:selector=>selector.startsWith('button')?{}:null}},native.root),false);assert.deepEqual(native.counts(),[0,0]);}
});
test('saving fieldsets cannot be activated even when the button itself has no disabled attribute',()=>{const f=fixture();f.button.closest=()=>({});assert.equal(handleStudyShortcut(f.event,f.root),false);assert.deepEqual(f.counts(),[0,0]);});
