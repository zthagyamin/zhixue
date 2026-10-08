import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=path=>readFileSync(new URL('../app/'+path,import.meta.url),'utf8');
test('tutorial primary text uses the on-accent token instead of a fixed dark colour',()=>{
 const css=read('onboarding.css');assert.match(css,/\.onboarding-primary\{[^}]*color:var\(--study-on-accent/);
 assert.match(css,/\.onboarding-primary:hover:not\(:disabled\)\{[^}]*--study-accent-hover/);
});
test('support surfaces pair background and foreground themes and keep the update warning explicit',()=>{
 const css=read('release-support.css');assert.match(css,/\.support-page\{[^}]*color:var\(--ink[^}]*background:var\(--paper/);
 assert.doesNotMatch(css,/background:#fff;color:#243729/);assert.match(css,/\.release-notice\{[^}]*background:#f4ead0;color:#42371b/);
});
test('updates help matches the first-visit policy and the current settings destination',()=>{
 const source=read('updates/page.tsx');assert.match(source,/首次进入学习页不自动弹出公告/);assert.match(source,/设置 → 维护与公告 → 产品更新日志/);
 assert.doesNotMatch(source,/版本未读时提示一次/);
});
