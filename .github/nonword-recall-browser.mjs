// Actual Recall + application session + IndexedDB. Synthetic models and owner only.
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile,mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
import {createServer} from 'vite';
import react from '@vitejs/plugin-react';
const {chromium}=createRequire(resolve(process.env.UX_BROWSER_DRIVER,'package.json'))('playwright');
const project=process.cwd().replaceAll('\\','/');
const root=await mkdtemp(resolve(tmpdir(),'zhixue-nonword-recall-browser-')),evidence=resolve(process.env.UX_EVIDENCE||resolve(root,'evidence'));
await mkdir(root,{recursive:true});await mkdir(evidence,{recursive:true});
await writeFile(resolve(root,'entry.jsx'),(await readFile(new URL('./nonword-recall-fixture.txt',import.meta.url),'utf8')).replaceAll("'../../","'/@fs/"+project+"/"));
await writeFile(resolve(root,'index.html'),'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/entry.jsx"></script></html>');
const origin='http://127.0.0.1:4194';
const server=await createServer({configFile:false,root,publicDir:false,css:{postcss:process.cwd()},cacheDir:resolve(root,'.vite'),plugins:[react()],resolve:{alias:{react:resolve('node_modules/react'),'react-dom':resolve('node_modules/react-dom')}},server:{host:'127.0.0.1',port:4194,strictPort:true,fs:{allow:[root,process.cwd()]}},logLevel:'error'});
let browser,failure=null;const results=[];
try{
  await server.listen();browser=await chromium.launch({headless:true,...(process.env.EDU_CHROMIUM_PATH?{executablePath:process.env.EDU_CHROMIUM_PATH}:{})});
  for(const viewport of [{width:1440,height:900},{width:390,height:844}])for(const theme of ['light','dark'])for(const mode of ['zero','correct','partial','incorrect']){
    const context=await browser.newContext({viewport});context.setDefaultTimeout(15000);
    await context.route('**/*',route=>{const url=new URL(route.request().url());return url.origin===origin&&!url.pathname.startsWith('/api/')?route.continue():route.abort('blockedbyclient');});
    const page=await context.newPage(),errors=[];page.on('pageerror',value=>errors.push(value.message));
    await page.goto(`${origin}/?theme=${theme}&mode=${mode}`);
    await page.getByRole('textbox',{name:'写下你回忆到的内容'}).fill('我的原始回答');
    await page.getByRole('button',{name:'提交并核对',exact:true}).click();
    await page.waitForFunction(async()=>{const row=await window.__nonwordProbe.read();return row?.evaluation.status==='pending'||row?.evaluation.status==='resolved';});
    let row=await page.evaluate(()=>window.__nonwordProbe.read());
    assert.equal(row.submitted.answer,'我的原始回答');
    assert.equal(row.formal,null);
    assert.equal(await page.evaluate(()=>window.__nonwordProbe.calls.includes('formal')),false);
    if(mode==='zero'){
      assert.equal(row.evaluation.status,'pending');assert.equal(await page.getByRole('radio',{name:'记得清楚',exact:true}).count(),0);
      assert.equal(await page.evaluate(()=>window.__nonwordProbe.calls.includes('assess')),false);
      await page.screenshot({path:resolve(evidence,`pending-${theme}-${viewport.width}.png`),fullPage:true});
      await page.reload();await page.getByRole('button',{name:'提交并核对',exact:true}).waitFor();
      assert.equal(await page.getByRole('textbox',{name:'写下你回忆到的内容'}).inputValue(),'我的原始回答');
      await page.getByRole('button',{name:'保存的答案稍后核对，继续',exact:true}).click();
      await page.getByRole('heading',{name:'已继续，答案待核对',exact:true}).waitFor();
      row=await page.evaluate(()=>window.__nonwordProbe.read());
      assert.equal(row.evaluation.status,'pending');assert.equal(row.checkpoint.traversed,true);assert.equal(row.submitted.answer,'我的原始回答');
      assert.equal(row.formal,null);assert.equal(await page.evaluate(()=>window.__nonwordProbe.calls.includes('formal')),false);
    }else{assert.equal(row.evaluation.status,'resolved');assert.equal(row.evaluation.outcome,mode);}
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
    assert.deepEqual(errors,[]);results.push({viewport:viewport.width,theme,mode,passed:true});await context.close();
  }
}catch(error){failure=String(error.stack||error);throw error;}
finally{
  await writeFile(resolve(evidence,'results.json'),JSON.stringify({sha:process.env.TARGET_SHA||process.env.GITHUB_SHA||null,expected:16,passed:results.length,complete:!failure&&results.length===16,failure,results},null,2));
  await browser?.close();await server.close();
}
