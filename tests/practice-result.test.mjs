import assert from 'node:assert/strict';
import test from 'node:test';
import {loadTsx} from './fixtures/tsx-components.mjs';
import {renderToStaticMarkup} from 'react-dom/server';

const {practiceSessionResult,practiceResultView}=loadTsx(new URL('../src/features/review-session/result.ts',import.meta.url));
const {PracticeResult}=loadTsx(new URL('../src/features/review-session/result-view.tsx',import.meta.url));

test('manual stop with unanswered items cannot claim completion',()=>{
 const result=practiceSessionResult({answered:1,correct:1,wrong:0},'stopped',{remaining:4});
 assert.equal(result.reason,'stopped');
 assert.equal(practiceResultView(result).title,'已提前结束');
 assert.equal(result.remaining,4);
});
test('empty result and unavailable recovery do not become successful rounds',()=>{
 for(const [reason,title] of [['empty','当前暂无复习题'],['recovery-error','题组恢复未完成']]){
  assert.equal(practiceResultView(practiceSessionResult({answered:0,correct:0,wrong:0},reason)).title,title);
 }
});
test('exhausted traversal preserves unknown counts and does not infer a task completion',()=>{
 const result=practiceSessionResult({answered:2,correct:1,wrong:1},'exhausted');
 assert.equal(result.awaitingReview,undefined);assert.equal(result.skipped,undefined);
 assert.equal(practiceResultView(result).title,'本轮练习结束');
 const html=renderToStaticMarkup(PracticeResult({result,onBack(){}}));
 assert.doesNotMatch(html,/<h2>[^<]*完成|<p>今日这项任务已完成<\/p>|待核对 0/);
});
test('pending and skipped are separate question counts, never inflated answer counts',()=>{
 const result=practiceSessionResult({answered:2,correct:1,wrong:1},'exhausted',{awaitingReview:3,skipped:2,remaining:0});
 assert.equal(result.answered,2);assert.equal(result.awaitingReview,3);assert.equal(result.skipped,2);
 const html=renderToStaticMarkup(PracticeResult({result,onBack(){},onPending(){}}));
 assert.match(html,/已核对 2 次/);assert.match(html,/待核对 3 题/);assert.match(html,/暂时跳过 2 题/);
 assert.match(html,/查看待核对答案/);assert.doesNotMatch(html,/作答 7|全部完成/);
});
test('summary separates submitted rounds from a zero-answer exit',()=>{
 const html=renderToStaticMarkup(PracticeResult({result:practiceSessionResult({answered:0,correct:0,wrong:0},'stopped'),onBack(){}}));
 assert.match(html,/本次未形成已核对的作答/);assert.doesNotMatch(html,/已保存到本机|全部同步/);
});
test('only explicit task evidence can add the task-complete notice',()=>{
 const result=practiceSessionResult({answered:1,correct:1,wrong:0},'exhausted');
 assert.doesNotMatch(renderToStaticMarkup(PracticeResult({result,onBack(){}})),/今日这项任务已完成/);
 assert.match(renderToStaticMarkup(PracticeResult({result,taskComplete:true,onBack(){}})),/今日这项任务已完成/);
});
