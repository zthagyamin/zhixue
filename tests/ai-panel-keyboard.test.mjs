import test from 'node:test';
import assert from 'node:assert/strict';
import {tsxEffect} from './fixtures/tsx-handlers.mjs';

test('Escape belongs to the AI panel while outside typing remains undisturbed',()=>{
 let listener,closed=0,inside=false;
 class Node{}class Element extends Node{closest(){return null;}}
 const effect=tsxEffect(new URL('../app/components/ai-sidebar/study-ai-entry.tsx',import.meta.url),'const listener=',{Node,Element,mode:'docked',host:{current:{contains:()=>inside}},closePanel:()=>closed++,setMode:()=>closed++,document:{querySelector:()=>null},window:{addEventListener:(name,fn)=>{listener=fn;},removeEventListener(){}}});
 const cleanup=effect();const event={key:'Escape',target:new Element(),preventDefault(){}};
 listener(event);assert.equal(closed,0);
 inside=true;listener(event);assert.equal(closed,1);
 listener({...event,isComposing:true});assert.equal(closed,1);cleanup();
});
