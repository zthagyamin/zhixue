import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {loadTsx} from './fixtures/tsx-components.mjs';
import {assistanceView} from './fixtures/assistance-read.mjs';
let api;try{api=loadTsx(new URL('../app/assistance-history.tsx',import.meta.url));}catch(error){if(error.code!=='ENOENT')throw error;}
test('auxiliary history is secondary and never describes unobserved or empty help as independent mastery',async()=>{
  assert.equal(typeof api?.AssistanceHistory,'function');const view=await assistanceView(),event=view.summaries[0].parent.event;
  const entries=api.assistanceHistoryEntries([event],null,[]);assert.equal(entries.length,1);assert.equal(entries[0].summary,null);
  const html=renderToStaticMarkup(createElement(api.AssistanceHistory,{entries,phase:'ready',onRefresh(){}}));
  assert.match(html,/<details[^>]*>/);assert.doesNotMatch(html,/<details[^>]*\bopen/);assert.match(html,/辅助情况未知/);assert.doesNotMatch(html,/独立完成|已经掌握/);
});
test('account reception and applied writeback use different auxiliary labels',async()=>{
  const view=await assistanceView(),row=view.summaries[0],event=row.parent.event;
  let entries=api.assistanceHistoryEntries([event],view,[]);assert.equal(entries[0].state,'account-received');
  view.receipts=[{sequence:1,receipt:{summaryId:row.record.summary.summaryId,status:'applied'}}];entries=api.assistanceHistoryEntries([event],view,[]);assert.equal(entries[0].state,'applied');
});
test('failed auxiliary history preserves its known records but states the missing freshness check',()=>{
  assert.equal(typeof api?.AssistanceHistory,'function');const html=renderToStaticMarkup(createElement(api.AssistanceHistory,{entries:[],phase:'failed',onRefresh(){}}));
  assert.match(html,/尚未完整核对/);assert.doesNotMatch(html,/全部同步成功|0 次辅助/);
});
