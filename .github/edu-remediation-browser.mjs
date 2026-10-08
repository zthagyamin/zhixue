// Real plugins and temporary drafts; isolated synthetic state, no production writes or model calls.
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
const {chromium}=createRequire(resolve(process.env.UX_BROWSER_DRIVER,'package.json'))('playwright');
const root=resolve('scratch/edu-remediation'),evidence=resolve(process.env.UX_EVIDENCE);
await mkdir(root,{recursive:true});await mkdir(evidence,{recursive:true});
await writeFile(resolve(root,'entry.tsx'),await readFile(new URL('./edu-remediation-fixture.txt',import.meta.url),'utf8'));
await writeFile(resolve(root,'python-port.ts'),await readFile(new URL('./edu-remediation-python-port.txt',import.meta.url),'utf8'));
await writeFile(resolve(root,'index.html'),'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/entry.tsx"></script></html>');
const origin='http://127.0.0.1:4189';
const server=await createServer({configFile:false,root,plugins:[{name:'synthetic-python-port',enforce:'pre',resolveId(id){if(id.endsWith('/hooks/use-pyodide'))return resolve(root,'python-port.ts');}},react()],server:{host:'127.0.0.1',port:4189,strictPort:true,fs:{allow:[process.cwd()]}},logLevel:'error'});
const cases=['recall','calculation','quiz','multiple','code','spelling','spelling-errors','flashcard','paper'];
const expected=cases.length*4,results=[];let browser,failure=null,activePage;
const frame=page=>page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
async function captureDialog(page){
 const query=new URL(page.url()).searchParams;
 await page.screenshot({path:resolve(evidence,`dialog-${query.get('mode')}-${query.get('theme')}-${page.viewportSize().width}.png`),fullPage:true});
 assert.equal(await page.locator('dialog.study-temporary-dialog[open]').evaluate(node=>node.scrollWidth<=node.clientWidth+1),true);
}
async function completeReflection(page,dialog){
 await dialog.getByRole('button',{name:'核对这次补练',exact:true}).click();
 await dialog.getByRole('checkbox').check();
 await dialog.getByRole('button',{name:'完成这次核对',exact:true}).click();
 await captureDialog(page);
 await dialog.getByRole('button',{name:'返回原反馈',exact:true}).click();
 await dialog.waitFor({state:'hidden'});await frame(page);
}
async function approveFile(page,dialog){
 const action=dialog.getByRole('button',{name:'批准并导出复测材料',exact:true});
 assert.equal(await action.isDisabled(),true);
 await dialog.getByRole('checkbox',{name:/我已核对/}).check();
 await dialog.getByRole('checkbox',{name:/我确认导出/}).check();
 await captureDialog(page);
 const pending=page.waitForEvent('download');await action.click();const download=await pending;
 assert.match(download.suggestedFilename(),/\.zhixue-candidates\.json$/);
 return JSON.parse(await readFile(await download.path(),'utf8'));
}
try{
 await server.listen();browser=await chromium.launch({headless:true});
 for(const viewport of [{width:1440,height:900},{width:390,height:844}])for(const theme of ['light','dark'])for(const mode of cases){
  const context=await browser.newContext({viewport});context.setDefaultTimeout(15000);const errors=[];
  context.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
  await context.route('**/*',route=>{const url=new URL(route.request().url());return url.origin===origin&&!url.pathname.startsWith('/api/')?route.continue():route.abort('blockedbyclient');});
  const page=await context.newPage();activePage=page;await page.goto(`${origin}/?theme=${theme}&mode=${mode}`);
  const dialog=page.locator('dialog.study-temporary-dialog[open]');
  if(mode==='recall'){
   await page.getByRole('textbox',{name:'写下你回忆到的内容'}).fill('原始独立回答');
   await page.getByRole('button',{name:'提交并核对',exact:true}).click();
   await page.getByRole('button',{name:'保留本次结果，针对要点补练',exact:true}).click();
   await dialog.getByRole('textbox',{name:'补练解释',exact:true}).fill('第一次补练输入');
   assert.deepEqual(await page.evaluate(()=>window.__remedy.grades),['again']);
   assert.equal(await page.evaluate(()=>window.__remedy.draft.read('answer','')),'原始独立回答');
   page.once('dialog',prompt=>prompt.accept());
   assert.equal(await page.evaluate(()=>window.__remedy.prepare()),true);
   await dialog.getByRole('textbox',{name:'补练解释',exact:true}).fill('等待导航时新增的补练输入');
   page.once('dialog',prompt=>prompt.dismiss());
   assert.equal(await page.evaluate(()=>window.__remedy.commitLeave()),false);
   await completeReflection(page,dialog);
   await page.getByRole('button',{name:'结束本轮',exact:true}).click();
  }else if(mode==='calculation'){
   await page.getByRole('textbox',{name:'你的答案',exact:true}).fill('1');
   await page.getByRole('button',{name:'提交',exact:true}).click();
   await page.getByRole('button',{name:'重算这一步（辅助练习）',exact:true}).click();
   await dialog.getByRole('textbox',{name:'补练解释',exact:true}).fill('相同数相减得到零。');
   await dialog.getByRole('textbox',{name:'补练最终结果',exact:true}).fill('0');
   await completeReflection(page,dialog);
   assert.equal(await page.evaluate(()=>window.__remedy.draft.read('value','')),'1');
   await page.getByRole('button',{name:'继续',exact:true}).click();
  }else if(mode==='quiz'||mode==='multiple'){
   if(mode==='quiz'){
    await page.getByRole('button',{name:/改变全部条件/}).click();
    await page.getByRole('button',{name:/控制其他条件/}).click();
    assert.equal(await page.getByRole('textbox',{name:'旧版巩固输入'}).count(),0);
   }else{
    await page.getByRole('button',{name:/C 忽略条件/}).click();
    await page.getByRole('button',{name:'提交答案',exact:true}).click();
    await page.getByText('错选：C；漏选：A、B。',{exact:true}).waitFor();
    await page.getByRole('button',{name:'对照材料解释错选与漏选（可跳过）',exact:true}).click();
    await dialog.getByRole('textbox',{name:'补练解释',exact:true}).fill('应控制变量，不能忽略条件。');
    await completeReflection(page,dialog);
   }
   await page.getByRole('button',{name:'记为需复习并继续',exact:true}).click();
  }else if(mode==='code'){
   await page.locator('.cm-content[contenteditable=true]').fill('def answer():\n    return -2');
   await page.getByRole('button',{name:/^▶.*运行测试/}).click();
   await page.getByText(/程序或断言未通过/).waitFor();
   await page.getByRole('button',{name:/查看题解/}).click();
   await page.getByRole('button',{name:'关闭题解后重写（辅助练习）',exact:true}).click();
   assert.equal(await page.getByText('参考解答 (Solution)',{exact:true}).count(),0);
   await dialog.locator('.cm-content[contenteditable=true]').fill('def answer():\n    return 0');
   await page.evaluate(()=>window.__remedy.pythonKind='ok');
   for(let i=0;i<2;i++){
    await dialog.getByRole('button',{name:'测试临时代码',exact:true}).click();
    await dialog.getByText(/本次辅助练习通过 1 项公开断言/).waitFor();
   }
   assert.deepEqual(await page.evaluate(()=>window.__remedy.grades),[]);
   assert.equal(await page.evaluate(()=>window.__remedy.draft.read('code','')),'def answer():\n    return -2');
   assert.equal(await page.evaluate(()=>window.__remedy.draft.read('firstTestCode','')),'def answer():\n    return -2');
   await page.evaluate(()=>window.__remedy.pythonKind='empty');
   await dialog.getByRole('button',{name:'测试临时代码',exact:true}).click();
   await dialog.getByText('题目测试未执行有效断言，不能判通过。',{exact:true}).waitFor();
   await page.evaluate(()=>window.__remedy.pythonKind='environment');
   await dialog.getByRole('button',{name:'测试临时代码',exact:true}).click();
   await dialog.getByText('执行环境或依赖准备失败，尚未判定作答。',{exact:true}).waitFor();
   await page.evaluate(()=>window.__remedy.pythonKind='hang');
   await dialog.getByRole('button',{name:'测试临时代码',exact:true}).click();
   await dialog.getByRole('button',{name:'停止本次运行',exact:true}).click();
   await page.evaluate(()=>window.__remedy.resolvePython({output:'late output',assertionsPassed:1}));await frame(page);
   assert.equal(await dialog.getByText('late output',{exact:true}).count(),0);
   assert.equal(await page.evaluate(()=>window.__remedy.cancels),1);
   await captureDialog(page);
   page.once('dialog',prompt=>prompt.accept());await dialog.getByRole('button',{name:'返回原反馈',exact:true}).click();
   await page.getByRole('button',{name:'继续',exact:true}).click();
  }else if(mode.startsWith('spelling')){
   const input=page.getByRole('textbox',{name:'拼写输入',exact:true});await input.waitFor();await frame(page);
   assert.deepEqual(await page.evaluate(()=>window.__remedy.speech),[]);
   assert.equal(await page.getByRole('button',{name:'朗读单词'}).count(),0);
   if(mode==='spelling'){
    await page.getByRole('combobox',{name:'拼写训练目的',exact:true}).selectOption('dictation');
    await frame(page);assert.deepEqual(await page.evaluate(()=>window.__remedy.speech),['tree']);
   }else{
    for(let i=0;i<3;i++){await input.press('x');await input.press('Backspace');}
   }
   await input.pressSequentially('tree');
  }else if(mode==='flashcard'){
   await page.getByRole('button',{name:/显示答案/}).click();
   await page.getByRole('button',{name:'把复杂背面整理为子卡候选',exact:true}).click();
   assert.equal(await dialog.getByRole('checkbox',{name:'候选 1',exact:true}).isChecked(),true);
   assert.equal(await dialog.getByRole('checkbox',{name:'候选 2',exact:true}).isChecked(),false);
   const artifact=await approveFile(page,dialog);
   assert.equal(artifact.parent.sourceVersion,'v1');assert.equal(artifact.items.length,1);
   assert.equal(artifact.items[0].reference,'A | B\nUse x < 1 & y > 0');assert.equal('rating' in artifact,false);
   assert.deepEqual(await page.evaluate(()=>window.__remedy.grades),[]);
   await dialog.getByRole('button',{name:'返回原反馈',exact:true}).click();
   await page.getByRole('button',{name:'把复杂背面整理为子卡候选',exact:true}).click();
   await dialog.getByRole('textbox',{name:'候选 1 题目',exact:true}).fill('新的候选输入');
   await page.evaluate(()=>window.__remedy.changeSource());
   await dialog.getByText(/原题或学习空间已变化/).waitFor();
   assert.equal(await dialog.getByRole('button',{name:'批准并导出复测材料',exact:true}).count(),0);
   await dialog.getByRole('button',{name:'返回原反馈',exact:true}).click();
   await page.getByRole('button',{name:'把复杂背面整理为子卡候选',exact:true}).click();
   await dialog.getByRole('textbox',{name:'候选 1 题目',exact:true}).fill('切换学习空间前的输入');
   await page.evaluate(()=>window.__remedy.invalidate());
   await dialog.getByText(/原题或学习空间已变化/).waitFor();
   assert.equal(await dialog.getByRole('button',{name:'批准并导出复测材料',exact:true}).count(),0);
   await dialog.getByRole('button',{name:'返回原反馈',exact:true}).click();
  }else if(mode==='paper'){
   const tab=page.getByRole('tab',{name:'主线填答',exact:true});if(viewport.width<800)await tab.click();
   await page.getByText('主线自检（自评草稿）',{exact:true}).click();
   await page.getByLabel('机制解释').selectOption({label:'还说不清'});
   await page.getByRole('button',{name:'从“还说不清”的项目准备复测候选',exact:true}).click();
   await dialog.getByRole('textbox',{name:'候选 1 参考说明',exact:true}).fill('The result requires fixed conditions.');
   await dialog.getByRole('textbox',{name:'候选 1 关键要点',exact:true}).fill('Check the boundary.');
   await dialog.getByRole('combobox',{name:'候选 1 内容属性',exact:true}).selectOption('limitation');
   const artifact=await approveFile(page,dialog);
   assert.equal(artifact.parent.key,'synthetic-remedy-paper');assert.equal(artifact.items[0].category,'limitation');
   assert.equal(artifact.items[0].citation.page,2);assert.deepEqual(await page.evaluate(()=>window.__remedy.grades),[]);
   await dialog.getByRole('button',{name:'返回原反馈',exact:true}).click();
  }
  if(!['flashcard','paper'].includes(mode)){
   await page.getByRole('heading',{name:'本轮练习结束',exact:true}).waitFor();
   assert.deepEqual(await page.evaluate(()=>window.__remedy.grades),[mode==='spelling'?'good':'again']);
   assert.equal(await page.evaluate(()=>window.__remedy.saves),1);
  }
  assert.equal(await page.evaluate(()=>window.__remedy.unchanged()),true);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  assert.deepEqual(errors,[]);await page.screenshot({path:resolve(evidence,`${mode}-${theme}-${viewport.width}.png`),fullPage:true});
  results.push({viewport:viewport.width,theme,case:mode,passed:true});await context.close();activePage=null;
 }
 assert.equal(results.length,expected);
}catch(error){failure=String(error.stack||error);if(activePage){await activePage.screenshot({path:resolve(evidence,'failure.png'),fullPage:true}).catch(()=>{});await writeFile(resolve(evidence,'failure-dom.txt'),await activePage.locator('body').innerText().catch(()=>''));}throw error;}
finally{
 const report={sha:process.env.GITHUB_SHA||null,expected,passed:results.length,complete:failure===null&&results.length===expected,failure,results};
 await writeFile(resolve(evidence,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await browser?.close();await server.close();
}
