// Current application + actual in-memory D1 handlers. No live models or learner records.
import {parseArgs} from 'node:util';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {createAccountPreview} from './account-preview.mjs';
import {startAccountPagePreview} from './automatic-day-preview.mjs';
import {createAccountStudyClient} from '../../app/account-study-client.ts';

export async function startNonwordStage3Preview({port=5296,devPort=5297,theme='light',run,mapping=false,semantic=false,stress=false}={}){
    if(!['light','dark'].includes(theme))throw Error('invalid-fixture-theme');
    if(run!==undefined&&(typeof run!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(run)))throw Error('invalid-fixture-run');
    const origin=`http://127.0.0.1:${port}`,userId=run?createHash('sha256').update('stage3-synthetic:'+run).digest('hex'):'e'.repeat(64);
    const account=await createAccountPreview({origin,userId,scenario:'all-plugins',stage3:true,stage3Mapping:mapping,stage3Semantic:semantic,stage3Stress:stress,syntheticAi:semantic});
    const client=createAccountStudyClient({companionUrl:origin,expectedUserId:userId,cache:null,
        fetcher:(path,init)=>account.handle(new Request(new URL(path,origin),{...init,headers:{...init?.headers,Origin:origin}}))});
    return startAccountPagePreview({account,client,port,devPort,decorateHtml:(html,url)=>{
        const requested=url.searchParams.get('theme'),selected=['light','dark'].includes(requested)?requested:theme;
        return url.pathname==='/study'?html.replace(/<head(?:\s[^>]*)?>/i,tag=>tag+`<script>localStorage.setItem('zhixue:appearance:theme:v1',${JSON.stringify(selected)});</script>`):html;
    }});
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
    const {values}=parseArgs({options:{port:{type:'string'},'dev-port':{type:'string'},theme:{type:'string'},run:{type:'string'},mapping:{type:'boolean',default:false},semantic:{type:'boolean',default:false},stress:{type:'boolean',default:false}}});
    const port=Number(values.port??5296),devPort=Number(values['dev-port']??5297);
    const preview=await startNonwordStage3Preview({port,devPort,theme:values.theme??'light',run:values.run,mapping:values.mapping,semantic:values.semantic,stress:values.stress});
    console.log(JSON.stringify({scope:'synthetic-in-memory-only',url:`http://127.0.0.1:${port}/study`,externalModels:'blocked'}));
    for(const signal of ['SIGINT','SIGTERM'])process.once(signal,async()=>{await preview.close();process.exit(0);});
}
