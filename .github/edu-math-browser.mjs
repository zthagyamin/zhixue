// Actual host/plugins/Worker with synthetic state. No production writes or paid model calls.
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
const {chromium}=createRequire(resolve(process.env.UX_BROWSER_DRIVER,'package.json'))('playwright');
const root=resolve('scratch/edu-math'),evidence=resolve(process.env.UX_EVIDENCE);
await mkdir(root,{recursive:true});await mkdir(evidence,{recursive:true});
await writeFile(resolve(root,'entry.tsx'),await readFile(new URL('./edu-math-fixture.txt',import.meta.url),'utf8'));
await writeFile(resolve(root,'index.html'),'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/entry.tsx"></script></html>');
const origin='http://127.0.0.1:4190';
const server=await createServer({configFile:false,root,plugins:[react()],server:{host:'127.0.0.1',port:4190,strictPort:true,fs:{allow:[process.cwd()]}},logLevel:'error'});
const cases=['final-only','steps','unknown','no-solution','not-unique','domain','source-change','extra','repeat','old-companion'];
const expected=cases.length*4,results=[];let browser,failure=null,activePage;
async function prepare(page,id,seed){
 await page.getByRole('button',{name:'换条件练习与数学步骤',exact:true}).click();
 const dialog=page.getByRole('dialog',{name:'换条件练习',exact:true});
 const action=dialog.getByRole('button',{name:'准备这道练习',exact:true});
 assert.equal(await action.isDisabled(),true);
 await dialog.getByRole('combobox',{name:'练习模板',exact:true}).selectOption(id);
 await dialog.getByRole('textbox',{name:'题目编号',exact:true}).fill(String(seed));
 await dialog.getByRole('checkbox',{name:/我确认练习目标/}).check();
 if(page.viewportSize().width<800)await action.tap();else await action.press('Enter');
 await dialog.getByRole('combobox',{name:'结论类型',exact:true}).waitFor();
 return dialog;
}
async function answer(dialog,kind,value){
 await dialog.getByRole('combobox',{name:'结论类型',exact:true}).selectOption(kind);
 if(kind==='number')await dialog.getByRole('textbox',{name:'变式最终结果',exact:true}).fill(value);
}
async function steps(dialog,method,condition,expression){
 await dialog.getByText('需要帮助？写出关键步骤',{exact:true}).click();
 await dialog.getByRole('combobox',{name:'采用的方法',exact:true}).selectOption(method);
 await dialog.getByRole('combobox',{name:'适用条件',exact:true}).selectOption(condition);
 await dialog.getByRole('textbox',{name:'局部变形',exact:true}).fill(expression);
}
const check=dialog=>dialog.getByRole('button',{name:'核对本次练习',exact:true}).click();
async function close(dialog){await dialog.getByRole('button',{name:'已核对本次结果',exact:true}).click();await dialog.getByRole('button',{name:'返回原反馈',exact:true}).press('Escape');await dialog.waitFor({state:'hidden'});}
async function capture(page,mode,theme,width){
 const dialog=page.getByRole('dialog',{name:'换条件练习',exact:true});
 assert.equal(await dialog.evaluate(node=>node.scrollWidth<=node.clientWidth+1),true);
 await page.screenshot({path:resolve(evidence,`${mode}-${theme}-${width}.png`)});
}
try{
 await server.listen();browser=await chromium.launch({headless:true});
 for(const viewport of [{width:1440,height:900},{width:390,height:844}])for(const theme of ['light','dark'])for(const mode of cases){
  const context=await browser.newContext({viewport,hasTouch:viewport.width<800});context.setDefaultTimeout(15000);const errors=[];
  context.on('page',page=>page.on('pageerror',error=>errors.push(error.message)));
  await context.route('**/*',route=>{const url=new URL(route.request().url());return url.origin===origin&&!url.pathname.startsWith('/api/')?route.continue():route.abort('blockedbyclient');});
  const page=await context.newPage();activePage=page;await page.goto(`${origin}/?theme=${theme}&mode=${mode}`);
  if(mode==='repeat'){
   await page.getByRole('button',{name:/忽略其他条件/}).click();
   await page.getByRole('button',{name:/控制其他条件/}).click();
   await page.getByRole('button',{name:'记为需复习并继续',exact:true}).click();
   await page.getByRole('button',{name:'重排复习',exact:true}).click();
   await page.getByText(/即时重练 · 不计入正式记录/).waitFor();
   await page.getByRole('button',{name:/控制其他条件/}).click();
   await page.getByRole('button',{name:'继续',exact:true}).click();
   await page.getByRole('heading',{name:'原题本轮结束',exact:true}).waitFor();
   assert.deepEqual(await page.evaluate(()=>window.__math.summary),{answered:1,correct:0,wrong:1});
  }else{
   await page.getByRole('textbox',{name:'你的答案',exact:true}).fill('3');
   await page.getByRole('button',{name:'提交',exact:true}).click();
   if(mode==='old-companion'){
    await page.getByRole('button',{name:'原题再练',exact:true}).click();
    await page.getByText(/返回了不受支持的题目改动/).waitFor();
    assert.equal(await page.getByRole('textbox',{name:'你的答案',exact:true}).inputValue(),'3');
   }else{
    const template=mode==='no-solution'||mode==='not-unique'?'inverse-linear':mode==='domain'?'cancel-domain':mode==='final-only'||mode==='extra'?'context-linear':'sqrt-sign';
    const seed=mode==='no-solution'?11:mode==='not-unique'?436:mode==='domain'?0:template==='context-linear'?17:9;
    let dialog=await prepare(page,template,seed);
    if(mode==='source-change'){
     await answer(dialog,'number','2');page.once('dialog',value=>value.accept());
     assert.equal(await page.evaluate(()=>window.__math.prepare()),true);
     await dialog.getByRole('textbox',{name:'变式最终结果',exact:true}).fill('3');
     page.once('dialog',value=>value.dismiss());assert.equal(await page.evaluate(()=>window.__math.commitLeave()),false);
     assert.equal(await dialog.getByRole('textbox',{name:'变式最终结果',exact:true}).inputValue(),'3');
     await page.evaluate(()=>window.__math.changeSource());await dialog.getByText(/原题或学习空间已变化/).waitFor();
     assert.equal(await dialog.getByRole('button',{name:'核对本次练习',exact:true}).count(),0);
     await capture(page,mode,theme,viewport.width);await dialog.getByRole('button',{name:'返回原反馈',exact:true}).click();
    }else{
     if(mode==='domain'){
      await answer(dialog,'not-allowed','');await steps(dialog,'divide','nonzero','x^2-7*x');await check(dialog);
      await dialog.getByText('最终结果：与本题规则一致',{exact:true}).waitFor();await dialog.getByText('所填步骤：需要再核对',{exact:true}).waitFor();
      await dialog.getByRole('combobox',{name:'采用的方法',exact:true}).selectOption('split-zero');
      await dialog.getByRole('combobox',{name:'适用条件',exact:true}).selectOption('includes-zero');await check(dialog);
      await dialog.getByText('所填步骤：与本题规则一致',{exact:true}).waitFor();
     }else if(mode==='steps'){
      await answer(dialog,'number','2');await steps(dialog,'principal-root','negative','x');await check(dialog);
      await dialog.getByText('最终结果：与本题规则一致',{exact:true}).waitFor();await dialog.getByText('所填步骤：需要再核对',{exact:true}).waitFor();
      await capture(page,mode+'-invalid',theme,viewport.width);
      await dialog.getByRole('textbox',{name:'局部变形',exact:true}).fill('0-x');await check(dialog);
      await dialog.getByText('所填步骤：与本题规则一致',{exact:true}).waitFor();
      await dialog.getByText('需要帮助？写出关键步骤',{exact:true}).click();
      await dialog.getByText(/本页已使用步骤或反馈辅助/).waitFor();
     }else if(mode==='unknown'){
      await answer(dialog,'number','abs(-2)');await check(dialog);await dialog.getByText('最终结果：暂时无法判定',{exact:true}).waitFor();
      await answer(dialog,'number','2');await steps(dialog,'principal-root','negative','abs(x)');await check(dialog);
      await dialog.getByText('所填步骤：暂时无法判定',{exact:true}).waitFor();
     }else{
      await answer(dialog,mode==='no-solution'?'none':mode==='not-unique'?'all':'number','29/5');await check(dialog);
      await dialog.getByText('最终结果：与本题规则一致',{exact:true}).waitFor();
      assert.equal(await dialog.getByRole('textbox',{name:'局部变形',exact:true}).count(),0);
     }
     await capture(page,mode,theme,viewport.width);await close(dialog);
     if(mode==='steps'){
      // Same source, closed and reopened dialog, different seed but identical problem.
      dialog=await prepare(page,'sqrt-sign',28);await dialog.getByText(/本页已使用步骤或反馈辅助/).waitFor();
      page.once('dialog',value=>value.accept());await dialog.getByRole('button',{name:'返回原反馈',exact:true}).click();
     }
    }
   }
   await page.getByRole('button',{name:'继续',exact:true}).click();
   if(mode==='extra'){
    // The child answer must not turn the original wrong answer into completion.
    const original=page.getByRole('textbox',{name:'你的答案',exact:true});await original.waitFor();
    assert.equal(await original.inputValue(),'');
    assert.equal(await page.getByRole('heading',{name:/本轮(巩固完成|练习结束)/}).count(),0);
    await original.fill('4');await page.getByRole('button',{name:'提交',exact:true}).click();
    await page.getByText('✓ 回答正确',{exact:true}).waitFor();
    await page.getByRole('button',{name:'继续',exact:true}).click();
    await page.getByRole('heading',{name:/本轮(巩固完成|练习结束)/}).waitFor();
   }else await page.getByRole('heading',{name:'原题本轮结束',exact:true}).waitFor();
  }
  assert.deepEqual(await page.evaluate(()=>window.__math.events),mode==='extra'?[]:['again']);
  assert.equal(await page.evaluate(()=>window.__math.grades),['repeat','extra'].includes(mode)?0:1);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
  assert.deepEqual(errors,[]);results.push({viewport:viewport.width,theme,case:mode,passed:true});await context.close();activePage=null;
 }
 assert.equal(results.length,expected);
}catch(error){failure=String(error.stack||error);if(activePage){await activePage.screenshot({path:resolve(evidence,'failure.png')}).catch(()=>{});await writeFile(resolve(evidence,'failure-dom.txt'),await activePage.locator('body').innerText().catch(()=>''));}throw error;}
finally{
 const report={sha:process.env.GITHUB_SHA||null,expected,passed:results.length,complete:failure===null&&results.length===expected,failure,results};
 await writeFile(resolve(evidence,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await browser?.close();await server.close();
}
