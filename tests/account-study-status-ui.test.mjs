import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {loadTsx} from './fixtures/tsx-components.mjs';
let ui;try{ui=loadTsx(new URL('../app/account-study-status.tsx',import.meta.url));}catch(error){if(error.code!=='ENOENT')throw error;}
test('identity failure is an explicit recovery page, not a guest or a zero-progress dashboard',()=>{
  assert.ok(ui?.StudyWorkspaceGate);const html=renderToStaticMarkup(createElement(ui.StudyWorkspaceGate,{phase:'identity-error',onRetry(){}}));
  assert.match(html,/无法确认账号/);assert.match(html,/重新检查/);assert.doesNotMatch(html,/本地游客|已完成 0/);
});
test('cached, failed, latest and not-connected account states stay distinct',()=>{
  assert.ok(ui?.AccountReadNotice);const html=state=>renderToStaticMarkup(createElement(ui.AccountReadNotice,{state,onRefresh(){}}));
  assert.match(html({phase:'cached',hasCache:true}),/已显示保存的资料/);assert.match(html({phase:'ready'}),/资料已更新/);
  assert.match(html({phase:'not-connected'}),/尚未连接/);assert.match(html({phase:'failed',hasCache:true}),/完整缓存/);
});
test('an unconnected account is a neutral starting point, never a bare failure line',()=>{
  assert.ok(ui?.AccountReadNotice);const html=state=>renderToStaticMarkup(createElement(ui.AccountReadNotice,{state,onRefresh(){}}));
  const notice=html({phase:'not-connected'});
  // A pill inside a real container, with the guidance text and a way forward instead of grey text
  // floating in the page whitespace.
  assert.match(notice,/study-account-read-pill/);assert.match(notice,/账号题库 · 尚未连接/);assert.doesNotMatch(notice,/尚未连接本机资料/);
  assert.match(notice,/正常的初始状态/);assert.match(notice,/\/companion-guide/);
  assert.doesNotMatch(notice,/账号资料读取失败/);
  const failed=html({phase:'failed'});
  assert.match(failed,/data-phase="failed"/);assert.match(failed,/账号资料读取失败/);
});

test('the actual notice slots render each state exactly once and retain actionable failures',()=>{
  for(const phase of ['loading','cached','ready','failed','library-changed']){
    const render=at=>renderToStaticMarkup(createElement(ui.AccountReadNoticeSlot,{at,hasSource:true,state:{phase},onRefresh(){},onResolveLibrary(){}}));
    const above=render('above'),details=render('details');
    assert.notEqual(Boolean(above),Boolean(details),phase);
    assert.match(above+details,new RegExp(`data-phase="${phase}"`));
    if(['failed','library-changed'].includes(phase))assert.match(above,/<button/);
    else assert.equal(above,'');
  }
});
