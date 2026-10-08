// Persistent version of the 16 previously reviewed first-arrival browser cases.
// Uses real React components with a synthetic identity; never a production site.
import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
import {seedFixtureStorage} from './browser-storage-fixture.mjs';
const {chromium} = createRequire(resolve(process.env.UX_BROWSER_DRIVER, 'package.json'))('playwright');
const current = JSON.parse(await readFile(new URL('../app/release-announcements.json', import.meta.url), 'utf8'))[0].version;
const root = resolve('scratch/ci-first-visit');
await mkdir(root, {recursive: true});
await writeFile(resolve(root, 'index.html'), '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/entry.tsx"></script></body></html>');
await writeFile(resolve(root, 'entry.tsx'), `
import React,{useState} from 'react';import {createRoot} from 'react-dom/client';
import {OnboardingProvider,StudyWelcome,OnboardingButton,useStudyArrival} from '../../app/onboarding';
import {ReleaseAnnouncement,ShowReleaseAnnouncementButton} from '../../app/release-announcement';
import {StudyTermHelp} from '../../app/study-term-help';import {DemoModeBadge} from '../../app/demo-mode-badge';
import '../../app/globals.css';import '../../app/release-support.css';
function Probe(){const arrival=useStudyArrival();const [busy,setBusy]=useState(location.search.includes('busy=1'));return <main className="study-app" data-arrival-ready={!!arrival.visit}>
 <StudyWelcome scope="account:fixture-user" isDemo onStart={()=>setBusy(true)} onSources={()=>{}}/>
 <h1>隔离验证：新用户入口</h1><p>这里使用真实组件与合成身份，不连接生产学习库。</p>
 <button type="button" onClick={()=>setBusy(false)}>完成模拟练习</button><ShowReleaseAnnouncementButton/><OnboardingButton/>
 <div><label>模拟未提交输入<input /></label></div>
 <section><h2>本轮练习完成</h2><DemoModeBadge/></section>
 <section><h2>术语说明</h2><p>复习安排<StudyTermHelp term="review"/></p><p>本地资料助手<StudyTermHelp term="companion"/></p><p>笔记中由知学维护的部分<StudyTermHelp term="managed"/></p></section>
 <ReleaseAnnouncement scope="account:fixture-user" ready blocked={busy}/>
 </main>}
createRoot(document.getElementById('root')!).render(<React.StrictMode><OnboardingProvider><Probe/></OnboardingProvider></React.StrictMode>);
`);
const origin = 'http://127.0.0.1:4173';
const server = await createServer({configFile: false, root, plugins: [react()], server: {host: '127.0.0.1', port: 4173, strictPort: true, fs: {allow: [process.cwd()]}}, logLevel: 'error'});
let browser;
const results = [];
const evidence = resolve(process.env.UX_EVIDENCE || 'scratch/ci-evidence/first-visit');
await mkdir(evidence, {recursive: true});
const scope = 'account:fixture-user';
const key = 'zhixue:study-visit:v1:' + encodeURIComponent(scope);
async function open(viewport, values = {}, query = '', denyStorage = false) {
 const context = await browser.newContext({viewport});
 context.setDefaultTimeout(15000);
 const errors = [];
 context.on('page', page => page.on('pageerror', error => errors.push({url: page.url(), message: error.message, stack: error.stack})));
 await context.route('**/*', route => {
  const url = new URL(route.request().url());
  if (url.origin !== origin) return route.abort('blockedbyclient');
  if (url.pathname === '/api/session') return route.fulfill({json: {authenticated: true, user: {userId: 'fixture-user', displayName: '测试用户', email: 'fixture@example.invalid'}}});
  if (url.pathname.startsWith('/api/')) return route.abort('blockedbyclient');
  return route.continue();
 });
 await context.addInitScript(seedFixtureStorage, {origin, values, denyStorage});
 const page = await context.newPage();
 await page.goto(origin + '/study' + query);
 await page.locator('[data-arrival-ready="true"]').waitFor();
 return {context, page, errors};
}
async function closed(page) {
 await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
 assert.equal(await page.locator('dialog[open]').count(), 0);
}
const oldRecord = JSON.stringify({firstVersion: '1.0.0', latestVersion: '1.0.0', upgradeVersion: null, welcomeDismissed: true});
let failure = null;
try {
 await server.listen();
 browser = await chromium.launch({headless: true});
 for (const viewport of [{width: 1440, height: 900}, {width: 390, height: 844}]) {
  const label = String(viewport.width);
  {
   const {context,page,errors} = await open(viewport);
   await closed(page); assert.equal(await page.locator('.study-first-visit').count(),1);
   assert.equal(await page.evaluate(version=>localStorage.getItem('zhixue:release-announcement:read:'+version),current),null);
   await page.reload(); await page.locator('[data-arrival-ready="true"]').waitFor(); await closed(page);
   await page.getByRole('button',{name:'收起入门指引'}).click(); await page.reload(); await page.locator('[data-arrival-ready="true"]').waitFor(); await closed(page);
   assert.equal(await page.locator('.study-first-visit').count(),0);
   await page.getByRole('button',{name:'查看本次公告',exact:true}).click(); await page.locator('.release-dialog[open]').waitFor();
   await page.getByRole('button',{name:/我知道了/}).click(); await closed(page);
   assert.deepEqual(errors,[]); results.push({viewport:label,case:'first visit, reload, dismissal and manual announcement',passed:true}); await context.close();
  }
  {
   const {context,page,errors} = await open(viewport,{[key]:oldRecord}); await page.locator('.release-dialog[open]').waitFor();
   const second=await context.newPage(); await second.goto(origin+'/study'); await second.locator('.release-dialog[open]').waitFor();
   await page.getByRole('button',{name:/我知道了/}).click(); await second.locator('.release-dialog[open]').waitFor({state:'hidden'}); await closed(page);
   assert.deepEqual(errors,[]); results.push({viewport:label,case:'real upgrade and cross-tab acknowledgement',passed:true}); await context.close();
  }
  {
   const {context,page,errors} = await open(viewport,{[key]:oldRecord},'?busy=1'); await closed(page); await page.getByRole('button',{name:'完成模拟练习'}).click(); await closed(page);
   assert.deepEqual(errors,[]); results.push({viewport:label,case:'active practice does not queue a later announcement',passed:true}); await context.close();
  }
  {
   const saved={version:1,step:2,path:'new',status:'active'};
   const {context,page,errors} = await open(viewport,{[key]:oldRecord,['zhixue:onboarding:v1:'+encodeURIComponent(scope)]:JSON.stringify(saved)});
   await page.locator('.site-onboarding[open]').waitFor(); assert.equal(await page.locator('dialog[open]').count(),1);
   await page.getByRole('button',{name:'跳过新手教学，稍后再看'}).click(); await closed(page); assert.deepEqual(errors,[]);
   results.push({viewport:label,case:'explicit tutorial resume does not stack the upgrade announcement',passed:true}); await context.close();
  }
  for (const status of ['skipped','completed']) {
   const handoff={version:1,step:6,path:'new',status};
   const {context,page,errors} = await open(viewport,{'zhixue:onboarding:login:v1':JSON.stringify(handoff)});
   await closed(page); assert.equal(await page.locator('.study-first-visit').count(),0);
   assert.equal(await page.evaluate(version=>localStorage.getItem('zhixue:release-announcement:read:'+version),current),null);
   assert.deepEqual(errors,[]); results.push({viewport:label,case:'login handoff '+status+' does not restart welcome',passed:true}); await context.close();
  }
  {
   const {context,page,errors} = await open(viewport,{},'',true); await closed(page); await page.getByRole('button',{name:'查看本次公告',exact:true}).click(); await page.locator('.release-dialog[open]').waitFor();
   await page.getByRole('button',{name:/我知道了/}).click(); await closed(page); assert.deepEqual(errors,[]);
   results.push({viewport:label,case:'blocked storage keeps first arrival quiet and manual help usable',passed:true}); await context.close();
  }
  {
   const {context,page,errors} = await open(viewport); await closed(page);
   const button=page.getByRole('button',{name:'复习安排：这是什么？'}); await button.focus(); await page.keyboard.press('Enter'); assert.equal(await button.getAttribute('aria-expanded'),'true');
   const target=await button.getAttribute('aria-controls'); assert.equal(await page.locator('[id="'+target+'"]').isVisible(),true);
   await page.keyboard.press('Escape'); assert.equal(await button.getAttribute('aria-expanded'),'false'); assert.equal(await button.evaluate(node=>node===document.activeElement),true);
   await page.keyboard.press('Space'); assert.equal(await button.getAttribute('aria-expanded'),'true'); await button.click();
   await page.getByRole('button',{name:'本地资料助手：这是什么？'}).click();
   assert.equal(await page.locator('.study-demo-badge').innerText(),'示例体验 · 不计入个人记录');
   assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
   await page.screenshot({path:resolve(evidence,'first-visit-'+label+'.png'),fullPage:true});
   assert.deepEqual(errors,[]); results.push({viewport:label,case:'keyboard/touch disclosures, Escape focus, calm badge and no horizontal overflow',passed:true}); await context.close();
  }
 }
 assert.equal(results.length,16,'All 16 first-visit scenarios must execute');
} catch (error) {
 failure = String(error.stack || error);
 throw error;
} finally {
 const report = {sha: process.env.GITHUB_SHA || null, expected: 16, passed: results.length, complete: failure === null && results.length === 16, failure, results};
 await writeFile(resolve(evidence,'results.json'),JSON.stringify(report,null,2));
 console.log(JSON.stringify(report,null,2));
 await browser?.close(); await server.close();
}
