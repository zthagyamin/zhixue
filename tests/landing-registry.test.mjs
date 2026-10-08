import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement as h} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {loadTsx} from './fixtures/tsx-components.mjs';
const {LandingContent}=loadTsx(new URL('../app/landing-content.tsx',import.meta.url));
const {registry}=loadTsx(new URL('../app/plugins/index.ts',import.meta.url));
const render=modes=>renderToStaticMarkup(h(LandingContent,{signedIn:false,modes}));

test('each actual registered capability has one homepage tab, with no short-ID duplicates',()=>{
  const modes=registry.getAll().map(({id,name,description})=>({id,name,description}));
  const html=render(modes);
  assert.equal((html.match(/role="tab"/g)||[]).length,modes.length);
});

test('custom-only and empty catalogues do not invent seven unavailable capabilities',()=>{
  const html=render([{id:'botany-fieldwork',name:'植物分类',description:'比较叶序。'}]);
  assert.equal((html.match(/role="tab"/g)||[]).length,1);
  assert.match(html,/植物分类/);assert.match(html,/比较叶序/);
  const empty=render([]);assert.equal((empty.match(/role="tab"/g)||[]).length,0);
  assert.match(empty,/暂无可用的学习方式/);
});
