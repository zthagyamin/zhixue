import assert from 'node:assert/strict';
import test from 'node:test';
import {tsxFunction} from './fixtures/tsx-functions.mjs';
const file=new URL('../app/account-study-controls.tsx',import.meta.url);
test('all shared-plan entry points check current local core coverage before publishing or calling AI',async()=>{
  for(const name of ['composition','save','approve','ai','decision']){
    let calls=0,checks=0,message='';const blocked=async()=>{checks++;throw new Error('本机作答尚待同步核对');};
    const env={workspaceId:'account:a',loaded:{catalog:{catalogHash:'catalog'}},submissionJournal:{},assertAccountPlanEvidence:blocked,
      state:{currentPlan:{catalogHash:'catalog'},approvedOperationId:'approved'},setBusy(){},setMessage:value=>message=value,aiServerAvailable:true,aiEnabled:true,
      client:{mutatePlan:async()=>{calls++;},recommendPlan:async()=>{calls++;}},sealCloudTaskPlan:async()=>{calls++;},composeAccountPlanningInput:async()=>{calls++;},toEngineTaskPlan:async()=>{calls++;},engineCatalog:Promise.resolve({subjects:[]})};
    const fn=tsxFunction(file,name,env);try{await fn(name==='decision'?'restore':{},0);}catch(error){message=error.message;}
    assert.equal(checks,1,`${name} must reread durable local evidence`);assert.equal(calls,0,name);assert.match(message,/核对/);
  }
});
