import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement as h} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {loadTsx} from './fixtures/tsx-components.mjs';
let ui={};
try{ui=loadTsx(new URL('../app/landing-content.tsx',import.meta.url));}catch(error){if(error.code!=='ENOENT'&&!String(error.message).includes('ENOENT'))throw error;}
const modes=[{id:'custom-astro',name:'天体观测回忆',description:'根据观测资料回忆。'},{id:'custom-lab',name:'实验过程练习',description:'回顾自己的实验记录。'}];
test('product homepage offers real signed-out and signed-in navigation without a new login system',()=>{
  assert.equal(typeof ui.LandingContent,'function');
  const guest=renderToStaticMarkup(h(ui.LandingContent,{signedIn:false,modes}));
  assert.match(guest,/href="\/signin-with-chatgpt\?return_to=\/study"/);
  assert.doesNotMatch(guest,/href="\/study(?:[?"])/);assert.match(guest,/\/downloads\/Zhixue-Companion-Setup.exe/);
  const member=renderToStaticMarkup(h(ui.LandingContent,{signedIn:true,displayName:'合成用户',modes}));
  assert.doesNotMatch(member,/signin-with-chatgpt/);assert.match(member,/继续学习/);
});
test('landing mode list renders supplied registered capabilities, including new categories',()=>{
  assert.equal(typeof ui.LandingContent,'function');
  const html=renderToStaticMarkup(h(ui.LandingContent,{signedIn:false,modes}));
  const modeSection=html.match(/<section\b[^>]*\bid="modes"[^>]*>([\s\S]*?)<\/section>/)?.[1];
  assert.ok(modeSection,'The registered modes must have a visible section.');
  assert.match(modeSection,/天体观测回忆/);assert.match(modeSection,/实验过程练习/);
  // Scope catalogue constraints to the catalogue: Windows installation conditions
  // elsewhere on the page must not look like a restriction on learning subjects.
  assert.match(modeSection,/根据观测资料回忆/);assert.doesNotMatch(modeSection,/只有.*七种|仅支持.*Python/);
});
test('landing keeps source, local-helper and account boundaries and does not promise fictitious adoption',()=>{
  assert.equal(typeof ui.LandingContent,'function');
  const html=renderToStaticMarkup(h(ui.LandingContent,{signedIn:false,modes:[]}));
  assert.match(html,/Windows/);assert.match(html,/账号题库/);assert.match(html,/原始资料/);assert.match(html,/在线/);
  assert.match(html,/自己.*AI|AI.*自己/);assert.match(html,/示例/);
  assert.doesNotMatch(html,/资料不离开.*设备|不把学习内容存进站主数据库|用户突破|100%掌握/);
});
