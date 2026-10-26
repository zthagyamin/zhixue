import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import ts from 'typescript';
import {createHooks,loader,deferred,tick,text,waitForObservation} from './helpers/causal-harness.mjs';

const workspaceFile=new URL('../app/components/ai-sidebar/study-ai-workspace.tsx',import.meta.url);
const source=readFileSync(workspaceFile,'utf8');
const compiled=ts.transpileModule(source,{fileName:fileURLToPath(workspaceFile),compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.ReactJSX,esModuleInterop:true}}).outputText;
const settings=(revision,enabled=true)=>({revision,enabled,configured:true,provider:'deepseek',model:'synthetic-model',baseUrl:'https://example.invalid',
  providers:{deepseek:{configured:true,model:'synthetic-model',baseUrl:'https://example.invalid'},chatgpt:{configured:false,model:'',baseUrl:'https://example.invalid'}},
  dailyRequestLimit:3,dailyTokenLimit:4000,concurrentLimit:1,maxOutputTokens:1000,serverAvailable:true});

function serviceFixture(initial=settings(1),holdInitial=false){
  const reads=[];let modelCalls=0;
  const service={settings:()=>{const request=deferred();reads.push(request);if(reads.length===1&&!holdInitial)request.resolve(initial);return request.promise;},
    configure:async value=>value,testConnection:async()=>{modelCalls++;throw Error('Model tests are outside this configuration regression');}};
  return{service,reads,modelCalls:()=>modelCalls,initial};
}

// Execute the entire current workspace module. The shared loader's document has
// no selection APIs, so this file supplies only that inert DOM boundary locally.
// State, lifecycle, settings publication, service selection and the connection
// tester all come from production source; no source function is reimplemented.
function workspaceModule(hooks){
  const dependencies=loader(hooks.api),runtime={jsx:(type,props,key)=>({type,props,key}),jsxs:(type,props,key)=>({type,props,key}),Fragment:'Fragment'};
  const loadedModule={exports:{}};
  const require=name=>{
    if(name==='react')return hooks.api;
    if(name==='react/jsx-runtime')return runtime;
    if(name.endsWith('.css'))return{};
    const file=new URL(name.endsWith('.ts')?name:name+'.ts',workspaceFile);
    const relative=fileURLToPath(file).slice(fileURLToPath(new URL('../',import.meta.url)).length).replaceAll('\\','/');
    return dependencies(relative);
  };
  new Function('require','module','exports','document',compiled)(require,loadedModule,loadedModule.exports,
    {getSelection:()=>null,querySelector:()=>null,addEventListener(){},removeEventListener(){}});
  return loadedModule.exports;
}

async function mountWorkspace(fixture,{holdInitial=false,ownerId='synthetic-owner'}={}){
  let hooks=createHooks(),api=workspaceModule(hooks),props={scope:{mode:'local',ownerId,libraryId:'synthetic-library'},service:fixture.service,children:null};
  let element=api.StudyAIWorkspace(props);hooks.mount(element.type,element.props);hooks.flush();
  const render=()=>{hooks.render(props);hooks.flush();return hooks.view().props.value;};
  if(!holdInitial)await waitForObservation(async()=>{await tick();render();},()=>Boolean(hooks.view().props.value.settings),{label:'initial workspace settings'});
  const result={get hooks(){return hooks;},get props(){return props;},value:()=>hooks.view().props.value,render,
    changeService(service){props={...props,service};render();},
    changeOwner(nextOwner,service){
      const next={...props,scope:{...props.scope,ownerId:nextOwner},service},nextElement=api.StudyAIWorkspace(next);
      assert.notEqual(nextElement.key,element.key,'The real workspace must key owners separately');
      hooks.unmount();hooks=createHooks();api=workspaceModule(hooks);props=next;element=api.StudyAIWorkspace(props);
      hooks.mount(element.type,element.props);hooks.flush();
    },
    close(){hooks.unmount();assert.equal(fixture.modelCalls(),0);},
  };
  return result;
}

test('the real local overview cannot let its delayed reload overwrite a newer saved configuration',async()=>{
  const service=serviceFixture(),f=await mountWorkspace(service),hooks=createHooks();
  const Overview=loader(hooks.api,{
    'app/components/ai-sidebar/index.ts':{StudyAISettings:()=>null},
    'app/components/ai-sidebar/study-ai-workspace.tsx':{useOptionalStudyAIWorkspace:()=>f.value()},
  })('app/study-dashboard/settings-ai-panels.tsx').SettingsAiOverview;
  const props={scope:'synthetic-owner/synthetic-library',resource:service.service,account:false,signedIn:true,localOnline:true,
    read:async()=>{assert.fail('Local overview must not read account settings');},fallback:{label:'Old data',detail:'Old data',tone:'muted'},onOpen(){}};
  try{
    hooks.mount(Overview,props);hooks.flush();await waitForObservation(tick,()=>service.reads.length===2,{label:'overview configuration reload'});
    // This is the actual SettingsForm save callback boundary: accepted configure
    // response is sent to the workspace's public setSettings, without a model test.
    f.value().setSettings(await service.service.configure(settings(2,false)));f.render();
    service.reads[1].resolve(settings(1));await tick();f.render();hooks.render(props);hooks.flush();
    assert.equal(f.value().settings.revision,2);assert.equal(f.value().settings.enabled,false);
    assert.match(text(hooks.view()),/未启用/);assert.equal(f.value().error,'');
  }finally{hooks.unmount();f.close();}
});

test('an older reload failure cannot cover a successful save with an obsolete error',async()=>{
  const service=serviceFixture(),f=await mountWorkspace(service);
  try{
    const old=f.value().reload();f.value().setSettings(await service.service.configure(settings(2,false)));f.render();
    service.reads[1].reject(Error('Synthetic old read failed'));await old;f.render();
    assert.equal(f.value().settings.revision,2);assert.equal(f.value().settings.enabled,false);assert.equal(f.value().error,'');
  }finally{f.close();}
});

for(const outcome of ['success','failure'])test(`a newer successful reload is preserved when an older reload ends in ${outcome}`,async()=>{
  const service=serviceFixture(),f=await mountWorkspace(service);
  try{
    const old=f.value().reload(),newer=f.value().reload();
    service.reads[2].resolve(settings(3,false));await newer;f.render();
    if(outcome==='success')service.reads[1].resolve(settings(2));else service.reads[1].reject(Error('Synthetic obsolete read failure'));
    await old;f.render();assert.equal(f.value().settings.revision,3);assert.equal(f.value().settings.enabled,false);assert.equal(f.value().error,'');
  }finally{f.close();}
});

test('the initial effect read cannot overwrite a save accepted while bootstrap is pending',async()=>{
  const service=serviceFixture(settings(1),true),f=await mountWorkspace(service,{holdInitial:true});
  try{
    f.value().setSettings(await service.service.configure(settings(2,false)));f.render();
    service.reads[0].resolve(settings(1));await tick();f.render();
    assert.equal(f.value().settings.revision,2);assert.equal(f.value().settings.enabled,false);assert.equal(f.value().error,'');
  }finally{f.close();}
});

for(const outcome of ['success','failure'])test(`switching the same owner's service retires an old reload ${outcome}`,async()=>{
  const oldService=serviceFixture(settings(10)),nextService=serviceFixture(settings(1,false)),f=await mountWorkspace(oldService);
  try{
    const old=f.value().reload();f.changeService(nextService.service);
    await waitForObservation(async()=>{await tick();f.render();},()=>f.value().settings?.revision===1,{label:'replacement service configuration'});
    if(outcome==='success')oldService.reads[1].resolve(settings(11));else oldService.reads[1].reject(Error('Retired service failed'));
    await old;f.render();assert.equal(f.value().service,nextService.service);assert.equal(f.value().settings.revision,1);
    assert.equal(f.value().settings.enabled,false);assert.equal(f.value().error,'');assert.equal(nextService.modelCalls(),0);
  }finally{f.close();}
});

test('a retired owner cannot publish delayed reload or save callbacks into the next owner',async()=>{
  const oldService=serviceFixture(settings(10)),nextService=serviceFixture(settings(1,false)),f=await mountWorkspace(oldService);
  try{
    const retired=f.value(),old=retired.reload();f.changeOwner('replacement-owner',nextService.service);
    await waitForObservation(async()=>{await tick();f.render();},()=>f.value().settings?.revision===1,{label:'replacement owner configuration'});
    oldService.reads[1].resolve(settings(11));await old;retired.setSettings(settings(12));f.render();
    assert.equal(f.value().scope.ownerId,'replacement-owner');assert.equal(f.value().settings.revision,1);
    assert.equal(f.value().settings.enabled,false);assert.equal(f.value().error,'');assert.equal(nextService.modelCalls(),0);
  }finally{f.close();}
});
