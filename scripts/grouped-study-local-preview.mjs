// Passive local UI diagnosis. Browser input is performed through the supported browser tool.
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createWriteStream} from 'node:fs';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createAccountPreview} from '../tests/fixtures/account-preview.mjs';
import {startAccountPagePreview} from '../tests/fixtures/automatic-day-preview.mjs';
import {createAccountStudyClient} from '../app/account-study-client.ts';
import {startGroupedStudyProbe} from '../.github/grouped-study-probe.mjs';
import {loadTsx} from '../tests/fixtures/tsx-components.mjs';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

const port=4197,devPort=4198,origin=`http://127.0.0.1:${port}`;
const evidence=resolve(process.argv[2]||'scratch/grouped-local');await mkdir(evidence,{recursive:true});
const log=createWriteStream(resolve(evidence,'application.log'));
const dev=process.argv.includes('--external-dev')?null:spawn(process.execPath,['node_modules/vinext/dist/cli.js','dev','--hostname','127.0.0.1','--port',String(devPort)],
  {env:{...process.env,NEXT_TELEMETRY_DISABLED:'1'},stdio:['ignore','pipe','pipe'],windowsHide:true});
if(dev){dev.stdout.pipe(log);dev.stderr.pipe(log);}
let preview,traceNumber=0;
const stamp=Date.now().toString(),userId=createHash('sha256').update('synthetic-grouped-local-'+stamp).digest('hex');
const frame=`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>知学本机隔离验收</title><style>body{font:16px system-ui;background:#e9eeee;color:#183436;margin:16px}button{padding:10px;margin:6px}iframe{display:block;border:1px solid #7d9999;margin:10px auto;width:390px;height:844px;background:white}p{margin:8px}</style><h1>知学 · 本机隔离验收</h1><p>合成账号与题目。所有网页、记录和诊断仅在本机。宽度由下方独立页面视口决定。</p><button data-width="390">390px 窄屏</button><button data-width="1440">1440px 桌面</button><button data-theme="light">浅色重新打开</button><button data-theme="dark">深色重新打开</button><button id="restart">重新打开当前页面</button><p id="mode">390px · 浅色</p><iframe title="知学合成学习页面" src="/study?fixtureTheme=light"></iframe><script>const frame=document.querySelector('iframe');let theme='light';for(const button of document.querySelectorAll('[data-width]'))button.onclick=()=>{frame.style.width=button.dataset.width+'px';document.querySelector('#mode').textContent=button.dataset.width+'px · '+theme};for(const button of document.querySelectorAll('[data-theme]'))button.onclick=()=>{theme=button.dataset.theme;frame.src='/study?fixtureTheme='+theme};document.querySelector('#restart').onclick=()=>frame.src='/study?fixtureTheme='+theme+'&trial='+Date.now();</script></html>`;
try{
  const deadline=Date.now()+60000;let ready=false;
  while(Date.now()<deadline){try{ready=(await fetch(`http://127.0.0.1:${devPort}/`,{redirect:'manual',signal:AbortSignal.timeout(3000)})).status<500;if(ready)break;}catch{/* Owned local server is starting. */}await new Promise(done=>setTimeout(done,100));}
  if(!ready)throw Error('Local application did not start');
  const account=await createAccountPreview({origin,userId,groupedStudy:true,manyReviews:true,vagueRecall:process.argv.includes('--vague-recall'),reviewTarget:1});
  const client=createAccountStudyClient({companionUrl:origin,expectedUserId:userId,cache:null,
    fetcher:(path,init)=>account.handle(new Request(new URL(path,origin),{...init,headers:{...init?.headers,Origin:origin}}))});
  preview=await startAccountPagePreview({account,client,port,devPort,
    intercept:async(req,res)=>{
      // Block connections to the real Companion and external services in this fixture.
      res.setHeader('Content-Security-Policy',`connect-src 'self' http://127.0.0.1:${devPort} ws://127.0.0.1:${devPort}; frame-src 'self'`);
      const url=new URL(req.url,origin);
      if(url.pathname==='/__fixture/view'){res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});res.end(frame);return true;}
      if(url.pathname==='/__fixture/layout'){
        const {DashboardFocusHero}=loadTsx(new URL('../app/dashboard-focus-hero.tsx',import.meta.url));
        const pending=url.searchParams.get('mode')==='pending';
        const markup=renderToStaticMarkup(createElement(DashboardFocusHero,{summary:{groups:pending?null:1,minutes:null,blocked:0},lead:pending?null:{taskId:'synthetic',title:'复习 · 回忆练习 A',kind:'next'},disabled:pending,onStart(){},onAdvanced(){}}));
        res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});
        res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>真实今日入口布局对照</title><link rel="stylesheet" href="/app/globals.css?direct"><link rel="stylesheet" href="/app/c-study.css?direct"><link rel="stylesheet" href="/app/study-interactions.css?direct"><div class="study-app" style="padding:16px"><a href="/__fixture/layout?mode=${pending?'ready':'pending'}">切换到${pending?'待自测':'核对中'}</a>${markup}<details class="study-plan-details"><summary>查看今日任务与进度</summary><p>合成布局对照</p></details></div></html>`);return true;
      }
      if(url.pathname==='/__fixture/trace'&&req.method==='POST'){
        if(req.headers.origin!==origin){res.writeHead(403).end();return true;}
        const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>1500000){res.writeHead(413).end();return true;}chunks.push(chunk);}
        const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if(!Array.isArray(value.entries)||value.entries.length>1200){res.writeHead(400).end();return true;}
        await writeFile(resolve(evidence,'interaction-latest.json'),JSON.stringify(value,null,2));
        if(value.final)await writeFile(resolve(evidence,`interaction-${++traceNumber}.json`),JSON.stringify(value,null,2));
        res.writeHead(204).end();return true;
      }
      return false;
    },
    decorateHtml:(html,url)=>{
      if(url.pathname!=='/study')return html;
      const theme=url.searchParams.get('fixtureTheme')==='dark'?'dark':'light';
      const script=`localStorage.setItem('zhixue:appearance:theme:v1',${JSON.stringify(theme)});(${startGroupedStudyProbe.toString()})({origin:${JSON.stringify(origin)}});let sent=-1;const send=final=>{const entries=window.__groupedTrace??[];if(!final&&entries.length===sent)return;sent=entries.length;const data=JSON.stringify({width:innerWidth,theme:${JSON.stringify(theme)},final,entries});if(final)navigator.sendBeacon('/__fixture/trace',new Blob([data],{type:'application/json'}));else fetch('/__fixture/trace',{method:'POST',headers:{'Content-Type':'application/json'},body:data}).catch(()=>{});};setInterval(()=>send(false),500);window.addEventListener('pagehide',()=>send(true));`;
      return html.replace(/<head(?:\s[^>]*)?>/i,tag=>tag+`<script>${script}</script>`);
    },
  });
  console.log(JSON.stringify({url:origin+'/__fixture/view',evidence,pid:process.pid,devPid:dev?.pid,mode:'synthetic-only; no external model or real learner data'}));
}catch(error){dev?.kill();log.end();throw error;}
async function close(){await preview?.close();dev?.kill();log.end();}
process.once('SIGINT',()=>{void close();});process.once('SIGTERM',()=>{void close();});
