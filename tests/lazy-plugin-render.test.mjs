import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {loadTsx} from './fixtures/tsx-components.mjs';
test('an unloaded plugin displays progress and never grades just by loading',async()=>{
 const {createLazyPlugin}=loadTsx(new URL('../app/plugins/lazy-plugin.tsx',import.meta.url));let loads=0,grades=0;
 const plugin=createLazyPlugin({id:'pending',name:'测试练习',description:'Fixture'},()=>{loads++;return new Promise(()=>{});});assert.equal(loads,0);assert.equal(plugin.name,'测试练习');
 const html=renderToStaticMarkup(createElement(plugin.renderUI,{data:{},onGrade:()=>grades++}));assert.match(html,/正在加载测试练习/);await Promise.resolve();assert.equal(loads,1);assert.equal(grades,0);
});
test('an already loaded plugin renders the next card without another loading screen',async()=>{
 const {createLazyPlugin}=loadTsx(new URL('../app/plugins/lazy-plugin.tsx',import.meta.url));
 const plugin=createLazyPlugin({id:'warm',name:'连续练习',description:'Fixture'},async()=>({id:'warm',renderUI:({data})=>createElement('p',null,data.label)}));
 renderToStaticMarkup(createElement(plugin.renderUI,{data:{label:'第一题'},onGrade(){}}));
 await new Promise(resolve=>setImmediate(resolve));
 const next=renderToStaticMarkup(createElement(plugin.renderUI,{data:{label:'下一题内容'},onGrade(){}}));
 assert.match(next,/下一题内容/);assert.doesNotMatch(next,/正在加载连续练习/);
});
