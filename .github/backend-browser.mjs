import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createRequire} from 'node:module';
import {createServer} from 'vite';

const {chromium}=createRequire(resolve(process.env.UX_BROWSER_DRIVER,'package.json'))('playwright');
const root=resolve('scratch/backend-boundaries'),evidence=resolve(process.env.UX_EVIDENCE),origin='http://127.0.0.1:4194';
await mkdir(root,{recursive:true});await mkdir(evidence,{recursive:true});
await writeFile(resolve(root,'entry.ts'),await readFile(new URL('./backend-fixture.txt',import.meta.url),'utf8'));
await writeFile(resolve(root,'index.html'),'<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>main{max-width:760px;margin:32px auto;padding:20px}h1{font-size:28px}button{margin:8px;padding:12px;border:1px solid #789;border-radius:6px}output{display:block;padding:18px;overflow-wrap:anywhere}p{line-height:1.7}</style><main><h1>知学 · 后端边界验收</h1><p>合成问题与存储；使用实际账号接口和流式解码，不写学习成绩。</p><button data-action="run">发送合成问题</button><button data-action="cancel">取消请求</button><p role="status" aria-label="请求状态">尚未开始</p><output aria-label="模型回复"></output></main><script type="module" src="/entry.ts"></script></html>');
const fixtures=new Map(),settings={provider:'deepseek',model:'synthetic-chat',baseUrl:'https://api.deepseek.com',revision:1,maxOutputTokens:100};
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};
let createHandlers;
function dependencies(state){
  const trace=state.trace;
  return{enabled:true,getBrowserUser:async()=>({userId:'synthetic'}),getAccessStore:async()=>({profile:async()=>({libraryId:'library'})}),
    planAiAvailable:()=>true,getAiStore:async()=>({
      getSettings:async()=>settings,
      begin:async()=>{trace.push('begin');return state.saved?{status:'completed',result:state.saved}:{status:'accepted',settings};},
      complete:async(_owner,_id,_hash,value)=>{trace.push('complete-attempt');if(state.scenario==='completion-store-error')throw Error('storage unavailable');state.saved=value;trace.push('complete');},
      fail:async()=>{trace.push('fail');if(state.scenario==='failure-store-error')throw Error('storage unavailable');},
    }),
    getChatAi:async()=>{
      trace.push('load');if(state.scenario==='cancel-during-load')await state.gate.promise;
      return{async *stream(_request,_budget,signal){
        trace.push('stream');signal.throwIfAborted();
        if(['provider-error','failure-store-error'].includes(state.scenario))throw Error('provider unavailable');
        yield{type:'delta',text:'合成回复：请先独立回忆，再核对资料。'};
        if(state.scenario==='cancel-during-stream')await new Promise(done=>{if(signal.aborted)done();else signal.addEventListener('abort',done,{once:true});});
        signal.throwIfAborted();yield{type:'done',model:settings.model};
      }};
    },
  };
}
const server=await createServer({configFile:false,root,server:{host:'127.0.0.1',port:4194,strictPort:true,fs:{allow:[process.cwd()]}},logLevel:'error',plugins:[{
  name:'synthetic-account-transport',configureServer(vite){vite.middlewares.use(async(req,res,next)=>{
    const url=new URL(req.url,origin);if(url.pathname!=='/api/account-study'){next();return;}
    const state=fixtures.get(url.searchParams.get('fixture'));if(!state){res.writeHead(404).end();return;}
    const abort=new AbortController();let reader;
    req.on('aborted',()=>abort.abort());res.on('close',()=>{if(!res.writableEnded){state.cancelled=true;abort.abort();void reader?.cancel();}});
    try{
      const chunks=[];for await(const chunk of req)chunks.push(chunk);
      const request=new Request(url,{method:'POST',headers:req.headers,body:Buffer.concat(chunks),signal:abort.signal});
      const response=await createHandlers(dependencies(state)).POST(request);
      if(res.destroyed){await response.body?.cancel();return;}
      res.writeHead(response.status,Object.fromEntries(response.headers));
      if(response.body){reader=response.body.getReader();while(!res.destroyed){const chunk=await reader.read();if(chunk.done)break;res.write(chunk.value);}}
      res.end();
    }catch(error){state.transportError=String(error);if(!res.destroyed)res.writeHead(500).end();}
    finally{reader?.releaseLock();}
  });},
}]});
const cases=['chat-success','provider-error','completion-store-error','failure-store-error','cancel-during-load','cancel-during-stream','wrong-library','invalid-bearer'];
const expected=32,results=[];let browser,activePage,failure=null;
const waitFor=async(check)=>{for(let i=0;i<150;i++){if(check())return;await new Promise(done=>setTimeout(done,20));}throw Error('Backend state did not settle');};
try{
  ({createAccountStudyHandlers:createHandlers}=await server.ssrLoadModule(resolve('app/account-study-api.ts')));
  await server.listen();browser=await chromium.launch({headless:true});
  for(const width of [1440,390])for(const theme of ['light','dark'])for(const scenario of cases){
    const id=`${scenario}-${theme}-${width}`,state={scenario,trace:[],gate:deferred(),saved:null};fixtures.set(id,state);
    const context=await browser.newContext({viewport:{width,height:900},hasTouch:width<800}),page=await context.newPage(),errors=[];activePage=page;page.setDefaultTimeout(15000);
    page.on('pageerror',error=>errors.push(error.message));
    await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.continue():route.abort('blockedbyclient'));
    await page.goto(`${origin}/?case=${scenario}&theme=${theme}&fixture=${id}`);await page.getByRole('button',{name:'发送合成问题',exact:true}).click();
    if(scenario.startsWith('cancel-')){
      await waitFor(()=>state.trace.includes(scenario==='cancel-during-load'?'load':'stream'));
      await page.getByRole('button',{name:'取消请求',exact:true}).click();
      await page.getByRole('status',{name:'请求状态',exact:true}).filter({hasText:'已取消'}).waitFor();
      // Wait for the real socket cancellation before releasing provider construction.
      if(scenario==='cancel-during-load')await waitFor(()=>state.cancelled===true);
      state.gate.resolve();await waitFor(()=>state.trace.includes('fail'));
      assert.equal(state.saved,null);assert.equal(state.trace.includes('complete-attempt'),false);
      if(scenario==='cancel-during-load')assert.equal(state.trace.includes('stream'),false);
    }else{
      await page.waitForFunction(()=>window.__backend.finished);
      const probe=await page.evaluate(()=>({events:window.__backend.events,status:window.__backend.status,headers:window.__backend.headers}));
      assert.equal(probe.headers['cache-control'],'no-store');assert.equal(probe.headers['x-content-type-options'],'nosniff');
      if(scenario==='chat-success'){
        assert.equal(probe.status,200);assert.equal(probe.events.at(-1).type,'done');assert.ok(state.saved);assert.equal(state.trace.filter(x=>x==='complete').length,1);
        await page.getByRole('button',{name:'发送合成问题',exact:true}).click();await page.waitForFunction(()=>window.__backend.finished);
        assert.equal(await page.getByRole('status',{name:'请求状态',exact:true}).innerText(),'已完成');assert.equal(state.trace.filter(x=>x==='stream').length,1);assert.equal(state.trace.filter(x=>x==='begin').length,2);
      }else{
        assert.equal(probe.events.some(event=>event.type==='done'),false);assert.equal(state.saved,null);assert.match(await page.getByRole('status',{name:'请求状态',exact:true}).innerText(),/请求失败/);
        if(['wrong-library','invalid-bearer'].includes(scenario)){assert.equal(probe.status,scenario==='wrong-library'?403:401);assert.deepEqual(state.trace,[]);assert.equal(probe.headers.vary,'Cookie, Authorization');}
        else{assert.equal(probe.status,200);assert.equal(state.trace.filter(x=>x==='fail').length,1);}
      }
    }
    assert.equal(state.transportError,undefined);assert.deepEqual(errors,[]);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),true);
    await page.screenshot({path:resolve(evidence,`${id}.png`),fullPage:true});results.push({case:scenario,theme,viewport:width,passed:true});await context.close();fixtures.delete(id);activePage=null;
  }
}catch(error){failure=String(error.stack||error);if(activePage){await activePage.screenshot({path:resolve(evidence,'failure.png')}).catch(()=>{});await writeFile(resolve(evidence,'failure-dom.txt'),await activePage.locator('body').innerText().catch(()=>''));}throw error;}
finally{
  for(const state of fixtures.values())state.gate.resolve();
  const report={sha:process.env.GITHUB_SHA||null,expected,passed:results.length,complete:!failure&&results.length===expected,failure,results};
  await writeFile(resolve(evidence,'results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));await browser?.close();await server.close();
}
