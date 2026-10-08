// Full application QA with real account handlers, synthetic data and an in-memory database.
import http from 'node:http';
import {createAccountPreview} from './account-preview.mjs';
import {previewHtml} from './preview-environment.mjs';
import {createAccountStudyClient} from '../../app/account-study-client.ts';
import {composeAccountPlanningInput} from '../../app/account-study-planning-projection.ts';
import {buildLongTermPlanningInput} from '../../app/long-term-planning-input.ts';
import {generateLongTermSchedule} from '../../app/long-term-pacing.ts';
import {dateOffset} from '../../app/long-term-plan-types.ts';
import {studyDay} from '../../src/domain/planning/index.ts';

export async function startAutomaticDayPreview({port=3044,devPort=3012,scenario='enabled',now=new Date().toISOString()}={}){
  if(!['enabled','paused','existing','rejected'].includes(scenario))throw new Error('Unknown automatic day scenario');
  const origin=`http://127.0.0.1:${port}`,day=studyDay(now),userId='d'.repeat(64);
  const account=await createAccountPreview({origin,day,userId,scenario:['existing','rejected'].includes(scenario)?'draft-15':'no-plan'});
  const client=createAccountStudyClient({companionUrl:origin,expectedUserId:userId,cache:null,
    fetcher:(path,init)=>account.handle(new Request(new URL(path,origin),{...init,headers:{...init?.headers,Origin:origin}}))});
  const loaded=await client.load(),yesterday=dateOffset(day,-1);
  const composed=await composeAccountPlanningInput({...loaded,day:yesterday,previous:null}),source=buildLongTermPlanningInput(composed.input);
  const snapshot=generateLongTermSchedule(source.inventory,{planId:'automatic-browser',startDate:yesterday,targetDeadline:dateOffset(day,4),
    dailyMinutesBudget:{workdayMin:0,workdayMax:60,weekendMax:60,minReviewRatio:0.35},bufferRatio:0,
    subjectsConfig:[...new Set(source.inventory.map(item=>item.subjectId))].map(subjectId=>({subjectId,priority:1,completionCriteria:'fixed-rounds',requiredRounds:1,dailyQuotaTarget:2}))},
    source.fsrsMap,{asOfDate:yesterday,generatedAt:yesterday+'T00:00:00.000Z'});
  await client.mutateLongTermPlan({operationId:'seed-goals',expectedRevision:0,enabled:scenario!=='paused',snapshot});
  if(scenario==='rejected'){
    const draft=await client.getPlanState(day);
    await client.mutatePlan({action:'reject',operationId:'seed-reject',expectedRevision:1,day,planHash:draft.currentPlan.cloudPlanHash});
  }
  return startAccountPagePreview({account,client,port,devPort});
}

/** Shared isolated HTTP surface for full-page browser regressions. */
export async function startAccountPagePreview({account,client,port,devPort,intercept,decorateHtml=html=>html}){
  const origin=`http://127.0.0.1:${port}`,{day,userId}=account;
  const original=await client.getPlanState(day),mutations=[];
  const server=http.createServer(async(req,res)=>{
    try{
      const url=new URL(req.url,origin);
      const json=(value,status=200)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
      if(intercept&&await intercept(req,res))return;
      if(url.pathname==='/__fixture/status')return json({...account.inspect(),mutations,plan:await client.getPlanState(day)});
      if(url.pathname==='/api/session')return json({authenticated:true,user:{userId,displayName:'自动今日安排 · 隔离验收',email:''}});
      if(url.pathname==='/api/account-study'){
        const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks);
        if(req.method==='POST'){const value=JSON.parse(body);if(value.action==='mutate-plan')mutations.push(value.mutation.action);}
        const response=await account.handle(new Request(url,{method:req.method,headers:req.headers,...(req.method==='POST'?{body}:{})}));
        res.writeHead(response.status,Object.fromEntries(response.headers));return res.end(await response.text());
      }
      if(url.pathname==='/api/sync'&&req.method==='GET')return json({hasProgress:false,progress:{itemStages:{},fsrsData:{},answered:0,correct:0},cursor:0,syncedAt:null});
      if(url.pathname.startsWith('/api/')||!['GET','HEAD'].includes(req.method))return json({error:'fixture-route-blocked'},404);
      const response=await fetch(`http://127.0.0.1:${devPort}${url.pathname}${url.search}`,{redirect:'manual',headers:{accept:req.headers.accept||'*/*','sec-fetch-dest':req.headers['sec-fetch-dest']||'',
        'oai-authenticated-user-id':userId,'oai-authenticated-user-email':'synthetic@fixture.invalid'}});
      if(response.status>=300&&response.status<400)return json({error:'fixture-redirect-blocked'},403);
      const type=response.headers.get('content-type')||'application/octet-stream';res.writeHead(response.status,{'content-type':type,'cache-control':'no-store'});
      if(type.includes('html'))res.end(decorateHtml(previewHtml(await response.text(),true),url));else res.end(Buffer.from(await response.arrayBuffer()));
    }catch(error){if(!res.headersSent)res.writeHead(502,{'content-type':'text/plain'});res.end(error.message);}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  return {origin,day,original,mutations,state:()=>client.getPlanState(day),goals:()=>client.getLongTermPlanState(),inspect:account.inspect,records:async()=>(await client.load()).records,
    close:async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));account.close();}};
}
