import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {loadTsx} from './fixtures/tsx-components.mjs';

const {default:UpdatesPage}=loadTsx(new URL('../app/updates/page.tsx',import.meta.url));
const markup=()=>renderToStaticMarkup(createElement(UpdatesPage));

test('release history places all dated entries in reverse chronological order',()=>{
  const dates=[...markup().matchAll(/<time[^>]*datetime="([^"]+)"/gi)].map(match=>match[1]);
  assert.ok(dates.length>1);
  assert.equal(dates[0],'2026-10-25');
  assert.deepEqual(dates,[...dates].sort((a,b)=>b.localeCompare(a)));
});

test('sorting retains older topics, every release anchor and native navigation',()=>{
  const html=markup();
  const announcements=JSON.parse(readFileSync(new URL('../app/release-announcements.json',import.meta.url),'utf8'));
  for(const entry of announcements)assert.ok(html.includes(`id="v${entry.version}"`));
  assert.match(html,/先试学，再找回材料继续练/);assert.match(html,/2026-09-14/);
  assert.match(html,/续学、进度与布局修复/);assert.match(html,/已有学习记录保留/);
  for(const href of ['/','/study','/help'])assert.ok(html.includes(`href="${href}"`));
});
