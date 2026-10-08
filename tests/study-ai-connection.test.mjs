import test from 'node:test';import assert from 'node:assert/strict';
let api;try{api=await import('../app/ai/study-ai-connection.ts');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
const settings={provider:'deepseek',model:'deepseek-v4-flash',revision:1};
test('service replacement clears testing and ignores a late success from the old service',async()=>{
 assert.equal(typeof api?.createStudyAIConnectionTester,'function');let finish,oldSignal;const states=[];
 const old=api.createStudyAIConnectionTester({testConnection:(_settings,signal)=>{oldSignal=signal;return new Promise(resolve=>{finish=resolve;});}},state=>states.push(state));old.reset();const pending=old.run(settings);assert.equal(states.at(-1).state,'testing');old.dispose();
 const fresh=api.createStudyAIConnectionTester({testConnection:async()=>({provider:settings.provider,model:settings.model,latencyMs:2})},state=>states.push(state));fresh.reset();assert.equal(states.at(-1),null);assert.equal(oldSignal.aborted,true);finish({model:'stale',provider:'deepseek',latencyMs:99});assert.equal(await pending,false);assert.equal(states.at(-1),null);assert.equal(await fresh.run(settings),true);assert.equal(states.at(-1).state,'connected');
});
test('reset permits a new attempt after disposal without reviving an old result',async()=>{const states=[],runner=api.createStudyAIConnectionTester({testConnection:async()=>{throw new Error('ai-provider-auth');}},state=>states.push(state));runner.dispose();runner.reset();assert.equal(await runner.run(settings),false);assert.equal(states.at(-1).state,'error');assert.match(states.at(-1).message,/密钥/);});
