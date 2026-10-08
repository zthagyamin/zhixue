import assert from 'node:assert/strict';
import test from 'node:test';
let read;try{read=(await import('../app/account-study-paging.ts')).readAccountPages;}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
const run=(pages,options={})=>{assert.equal(typeof read,'function');let calls=0;return read(async request=>{assert.equal(request.limit,20);return pages[calls++];},{collection:'records',...options});};
test('fenced reader accepts sequence gaps and nonterminal short pages',async()=>{
  assert.equal(typeof read,'function');const requests=[];
  const result=await read(async request=>{requests.push(request);return requests.length===1?{records:[{sequence:3}],nextCursor:3,through:9}:{records:[{sequence:9}],nextCursor:null,through:9};},{collection:'records',after:1});
  assert.deepEqual(result,{rows:[{sequence:3},{sequence:9}],through:9});assert.equal(requests[1].after,3);assert.equal(requests[1].through,9);assert.equal(requests[1].limit,20);
});
test('no new rows keeps the committed fence, rather than pretending history is empty',async()=>{
  assert.deepEqual(await run([{records:[],nextCursor:null,through:17}],{after:17}),{rows:[],through:17});
});
test('fence changes or a premature final page are rejected',async()=>{
  await assert.rejects(run([{records:[{sequence:1}],nextCursor:1,through:3},{records:[{sequence:3}],nextCursor:null,through:4}]));
  await assert.rejects(run([{records:[{sequence:1}],nextCursor:null,through:3}]));
  await assert.rejects(run([{records:[],nextCursor:null,through:3}]));
});
test('duplicate, decreasing and out-of-fence sequences cannot become usable history',async()=>{
  for(const records of [[{sequence:1},{sequence:1}],[{sequence:2},{sequence:1}],[{sequence:0}],[{sequence:4}]]){
    await assert.rejects(run([{records,nextCursor:null,through:3}]));
  }
});
test('next cursor must equal the last row and the page limit stays twenty',async()=>{
  await assert.rejects(run([{records:[{sequence:1}],nextCursor:2,through:3}]));
  await assert.rejects(run([{records:[],nextCursor:1,through:3}]));
  await assert.rejects(run([{records:Array.from({length:21},(_,index)=>({sequence:index+1})),nextCursor:null,through:21}]));
});
test('cancelled reads never publish partially parsed rows',async()=>{
  assert.equal(typeof read,'function');const control=new AbortController();let parsed=0;
  await assert.rejects(read(async()=>{control.abort();return{records:[{sequence:1}],nextCursor:null,through:1};},{collection:'records',signal:control.signal,parse:row=>{parsed++;return row;}}),error=>error.name==='AbortError');
  assert.equal(parsed,0);
});
test('row parsing cannot silently renumber the source sequence',async()=>{
  await assert.rejects(run([{records:[{sequence:1}],nextCursor:null,through:1}],{parse:row=>({...row,sequence:2})}));
});
