import assert from 'node:assert/strict';
import test from 'node:test';
import {studyHash} from '../app/account-study-content.ts';
let api;try{api=await import('../app/local-json-integrity.ts');}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
test('local checkpoint hashing preserves old integer hashes while allowing finite review decimals',async()=>{
  assert.equal(typeof api?.hashLocalJson,'function');const old={'😀':2,'\ue000':3,a:[1,true,null],absent:undefined};
  assert.equal(await api.hashLocalJson(old),await studyHash(old));
  assert.equal(api.canonicalLocalJson({b:0.212,a:{z:6.5}}),'{"a":{"z":6.5},"b":0.212}');
  assert.notEqual(await api.hashLocalJson({stability:0.212}),await api.hashLocalJson({stability:0.213}));
});
test('non-JSON metadata cannot silently become a valid local checksum',async()=>{
  assert.equal(typeof api?.hashLocalJson,'function');const circular={};circular.self=circular;const sparse=Array(2);sparse[1]=1;
  for(const value of [{value:NaN},{value:Infinity},{value:1n},{value:()=>1},new Date(),circular,sparse])await assert.rejects(api.hashLocalJson(value),/local-json/);
});
