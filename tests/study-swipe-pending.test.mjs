import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {loadTsx} from './fixtures/tsx-components.mjs';

test('a disabled draft fieldset blocks gestures at both pointerdown and pointerup',()=>{
 const {useStudySwipe}=loadTsx(new URL('../app/use-study-swipe.ts',import.meta.url));
 const saved={Element:globalThis.Element,window:globalThis.window,document:globalThis.document};
 class Element{closest(selector){return selector==='[data-swipe-reveal]'?this:null;}}
 globalThis.Element=Element;globalThis.window={getSelection:()=>({isCollapsed:true})};globalThis.document={querySelector:()=>null};
 try{
  let handlers,grades=0,blocked=true,captured=false;
  function Harness(){handlers=useStudySwipe({revealed:true,ready:true,busy:false,onReveal(){throw Error('Unexpected reveal');},onGrade(){grades++;}});return null;}
  renderToStaticMarkup(createElement(Harness));
  const currentTarget={closest:()=>blocked?{}:null,setPointerCapture(){captured=true;},hasPointerCapture:()=>captured,releasePointerCapture(){captured=false;}};
  const event={isPrimary:true,button:0,pointerType:'mouse',pointerId:1,currentTarget,target:new Element(),clientX:10,clientY:20,timeStamp:10};
  handlers.onPointerDown(event);handlers.onPointerUp({...event,clientX:120,timeStamp:100});assert.equal(grades,0);
  blocked=false;handlers.onPointerDown(event);blocked=true;handlers.onPointerUp({...event,clientX:120,timeStamp:100});assert.equal(grades,0);
  blocked=false;handlers.onPointerDown(event);handlers.onPointerUp({...event,clientX:120,timeStamp:100});assert.equal(grades,1);
 }finally{for(const [key,value]of Object.entries(saved)){if(value===undefined)delete globalThis[key];else globalThis[key]=value;}}
});
