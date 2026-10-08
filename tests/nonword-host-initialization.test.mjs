import test from 'node:test';
import assert from 'node:assert/strict';
import {createHostInitialization} from '../src/features/nonword-study/host-initialization.ts';

const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};

test('effect setup replay opens one bound durable driver without a second initial write',async()=>{
    const initialization=createHostInitialization(),gate=deferred();let creates=0;
    const create=()=>{creates++;return gate.promise;};
    const first=initialization.get('owner-A/library-A/source-v1/round-A',create);
    const replay=initialization.get('owner-A/library-A/source-v1/round-A',create);
    await Promise.resolve();
    assert.equal(creates,1);
    const driver={answer:'',formal:null};gate.resolve(driver);
    assert.equal(await first,driver);assert.equal(await replay,driver);
});

test('owner or source replacement does not inherit a pending driver or its failed initialization',async()=>{
    const initialization=createHostInitialization(),old=deferred(),current=deferred();let creates=0;
    const retired=initialization.get('owner-A/library/source-v1/round',()=>old.promise);
    const rejection=assert.rejects(retired,/retired initialization/);
    const next=initialization.get('owner-B/library/source-v2/round',()=>{creates++;return current.promise;});
    old.reject(Error('retired initialization'));await rejection;
    const replay=initialization.get('owner-B/library/source-v2/round',()=>{creates++;return Promise.resolve({wrong:true});});
    await Promise.resolve();assert.equal(creates,1);
    const driver={owner:'owner-B',source:'source-v2'};current.resolve(driver);
    assert.equal(await next,driver);assert.equal(await replay,driver);
});

test('failed initialization can be retried without reusing a rejected driver',async()=>{
    const initialization=createHostInitialization();let creates=0;
    await assert.rejects(initialization.get('bound',async()=>{creates++;throw Error('storage unavailable');}),/storage unavailable/);
    const driver={answer:'restored'};
    assert.equal(await initialization.get('bound',async()=>{creates++;return driver;}),driver);
    assert.equal(creates,2);
});
