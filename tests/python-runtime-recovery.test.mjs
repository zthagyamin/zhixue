import assert from 'node:assert/strict';
import test from 'node:test';
import {tsxEffect,tsxHandler} from './fixtures/tsx-handlers.mjs';
const file=new URL('../app/hooks/use-pyodide.ts',import.meta.url),tick=()=>new Promise(resolve=>setImmediate(resolve));

test('runtime loading retries with a fresh worker after failure',async()=>{
  let loads=0,ready=false,error,disposed=0;
  const effect=tsxEffect(file,'createPythonWorkerClient',{client:{current:null},createPythonWorkerClient:()=>({ready:async()=>{if(++loads===1)throw new Error('offline');},dispose:()=>disposed++}),setIsReady:value=>ready=value,setError:value=>error=value});
  const cleanup=effect();await tick();assert.equal(error,'offline');assert.equal(ready,false);cleanup();
  const cleanupAgain=effect();await tick();assert.equal(loads,2);assert.equal(ready,true);assert.equal(disposed,1);cleanupAgain();
});

test('unmounted runtime consumer disposes the worker and ignores delayed readiness',async()=>{
  let resolve,updates=0,disposed=0;const pending=new Promise(done=>resolve=done),client={current:null};
  const effect=tsxEffect(file,'createPythonWorkerClient',{client,createPythonWorkerClient:()=>({ready:()=>pending,dispose:()=>disposed++}),setIsReady:()=>updates++,setError:()=>updates++});
  const cleanup=effect();cleanup();resolve();await tick();assert.equal(updates,0);assert.equal(disposed,1);assert.equal(client.current,null);
});

test('retry clears readiness and errors without replacing editor input',()=>{
  let error='offline',epoch=0,ready=true;
  tsxHandler(file,'retry',{setIsReady:value=>ready=value,setError:value=>error=value,setEpoch:fn=>epoch=fn(epoch)})();
  assert.equal(error,null);assert.equal(epoch,1);assert.equal(ready,false);
});
