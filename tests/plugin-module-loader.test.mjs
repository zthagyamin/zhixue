import test from 'node:test';
import assert from 'node:assert/strict';
import {createPluginModuleLoader} from '../app/plugins/plugin-module-loader.ts';
const plugin={id:'fixture',name:'Fixture',description:'Fixture',renderUI:()=>null};
test('plugin metadata access does not load code and concurrent renders share a load',async()=>{
 let calls=0,resolve;const load=createPluginModuleLoader('fixture',()=>{calls++;return new Promise(done=>resolve=done);});assert.equal(calls,0);
 const first=load(),second=load();assert.equal(first,second);await Promise.resolve();assert.equal(calls,1);resolve(plugin);assert.equal(await first,plugin);assert.equal(await load(),plugin);assert.equal(calls,1);
});
test('a failed module can retry, and a mismatched plugin can never render',async()=>{
 let calls=0;const load=createPluginModuleLoader('fixture',async()=>{if(++calls===1)throw Error('offline');return plugin;});await assert.rejects(load(),/offline/);assert.equal(await load(),plugin);
 const mismatch=createPluginModuleLoader('expected',async()=>plugin);await assert.rejects(mismatch(),/plugin-module-mismatch/);
});
