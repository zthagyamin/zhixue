import assert from 'node:assert/strict';
import test from 'node:test';
import * as preview from './fixtures/preview-environment.mjs';
import {readFile} from 'node:fs/promises';
test('native preview permits the new paired auxiliary route while retaining the external-write guard',async()=>{
  const script=await readFile(new URL('../scripts/task-plan-browser-fixture.py',import.meta.url),'utf8');assert.match(script,/route != '\/v1\/assistance' and not route\.startswith\(allowed\)/);
  assert.match(script,/Configuration and external writes are disabled/);
});
test('silent preview disables only its own speech object and never changes production HTML',()=>{
  assert.equal(typeof preview.previewHtml,'function');const html='<html><head></head><body>Study</body></html>';
  assert.equal(preview.previewHtml(html,false),html);assert.match(preview.previewHtml(html,true),/speechSynthesis/);assert.match(preview.previewHtml(html,true),/data-preview-audio/);
});
let build;
try{build=(await import('./fixtures/preview-environment.mjs')).previewEnvironment;}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
test('preview child retains dense-review controls but never inherits provider credentials',()=>{
  assert.equal(typeof build,'function');
  const env=build({Path:'test-path',TEMP:'test-temp',DEEPSEEK_API_KEY:'synthetic-do-not-copy',TASK_PLAN_REVIEW_COUNT:'500'},false);
  assert.equal(env.TASK_PLAN_REVIEW_COUNT,'500');assert.equal(env.Path,'test-path');assert.equal(env.DEEPSEEK_API_KEY,undefined);
  assert.equal(env.PYTHONNOUSERSITE,'1');assert.equal(env.TASK_PLAN_REUSE_VAULT,undefined);
});
test('preview review count is bounded and reuse is explicit',()=>{
  assert.equal(typeof build,'function');
  assert.throws(()=>build({TASK_PLAN_REVIEW_COUNT:'-1'},false));
  assert.throws(()=>build({TASK_PLAN_REVIEW_COUNT:'5000000'},false));
  assert.equal(build({},true).TASK_PLAN_REUSE_VAULT,'1');
});
