import http from 'node:http';
import {createAccountPreview} from '../tests/fixtures/account-preview.mjs';
import {previewHtml} from '../tests/fixtures/preview-environment.mjs';
const port=Number(process.argv[2]??3021); if(!Number.isInteger(port)||port<3004||port>3099)throw new Error('Fixture port must be 3004..3099');
const origin=`http://127.0.0.1:${port}`,userId='b'.repeat(64);
const account=await createAccountPreview({origin,scenario:'no-plan',userId});
const mutations=[];
const server=http.createServer(async(req,res)=>{
 try{
  const url=new URL(req.url,origin),json=(value,status=200)=>{res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(value));};
  if(url.pathname==='/__fixture/status')return json({...account.inspect(),mutations});
  if(url.pathname==='/api/session')return json({authenticated:true,user:{userId,displayName:'确认开始 · 隔离测试账号',email:''}});
  if(url.pathname==='/api/account-study'){
   const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks);
   if(req.method==='POST'){const value=JSON.parse(body);if(value.action==='mutate-plan')mutations.push({action:value.mutation.action,operationId:value.mutation.operationId});}
   const response=await account.handle(new Request(url,{method:req.method,headers:req.headers,...(req.method==='POST'?{body}:{})}));
   res.writeHead(response.status,Object.fromEntries(response.headers));return res.end(await response.text());
  }
  if(url.pathname==='/api/sync'&&req.method==='GET')return json({hasProgress:false,progress:{itemStages:{},fsrsData:{},answered:0,correct:0},cursor:0,syncedAt:null});
  if(url.pathname.startsWith('/api/')||!['GET','HEAD'].includes(req.method))return json({error:'fixture-route-blocked'},404);
  const response=await fetch(`http://127.0.0.1:3011${url.pathname}${url.search}`,{redirect:'manual',headers:{accept:req.headers.accept||'*/*','sec-fetch-dest':req.headers['sec-fetch-dest']||'','oai-authenticated-user-id':userId,'oai-authenticated-user-email':'synthetic@fixture.invalid'}});
  if(response.status>=300&&response.status<400)return json({error:'fixture-redirect-blocked'},403);
  const type=response.headers.get('content-type')||'application/octet-stream';res.writeHead(response.status,{'content-type':type,'cache-control':'no-store'});
  if(/javascript|html/.test(type)){let body=(await response.text()).replaceAll('http://127.0.0.1:43121','http://127.0.0.1:43241');if(/html/.test(type))body=previewHtml(body,true);res.end(body);}else res.end(Buffer.from(await response.arrayBuffer()));
 }catch(error){if(!res.headersSent)res.writeHead(502,{'content-type':'text/plain'});res.end(error.message);}
});
server.listen(port,'127.0.0.1',()=>console.log(`Isolated real-handler account preview: ${origin}/study`));
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>{account.close();process.exit(0);}));
