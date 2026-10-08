// Synthetic real-host QA only; no paid providers or original learner material.
import {parseArgs} from 'node:util';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createAccountPreview} from './account-preview.mjs';
import {startAccountPagePreview} from './automatic-day-preview.mjs';
import {createAccountStudyClient} from '../../app/account-study-client.ts';

export async function startNonwordStage1Preview({port=4280,devPort=4238,theme='dark'}={}){
  if(!['light','dark'].includes(theme))throw Error('invalid-fixture-theme');
  const origin=`http://127.0.0.1:${port}`,userId='d'.repeat(64);
  const account=await createAccountPreview({origin,userId,scenario:'all-plugins',longReading:true});
  const client=createAccountStudyClient({companionUrl:origin,expectedUserId:userId,cache:null,
    fetcher:(path,init)=>account.handle(new Request(new URL(path,origin),{...init,headers:{...init?.headers,Origin:origin}}))});
  return startAccountPagePreview({account,client,port,devPort,decorateHtml:(html,url)=>
    url.pathname==='/study'?html.replace(/<head(?:\s[^>]*)?>/i,tag=>tag+`<script>localStorage.setItem('zhixue:appearance:theme:v1',${JSON.stringify(theme)});</script>`):html});
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const {values}=parseArgs({options:{port:{type:'string'},'dev-port':{type:'string'},theme:{type:'string'}}});
  const preview=await startNonwordStage1Preview({port:Number(values.port??4280),devPort:Number(values['dev-port']??4238),theme:values.theme??'dark'});
  console.log(JSON.stringify({scope:'synthetic-in-memory-only',url:`http://127.0.0.1:${values.port??4280}/study`,externalModels:'blocked'}));
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await preview.close();process.exit(0);});
}
