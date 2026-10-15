import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createPaperLibraryClient} from '../app/paper-library-client.ts';

const bytes=Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
const payload={localLibraryId:'local',accountLibraryId:'account',source:{kind:'vault',path:'paper.pdf',version:'a'.repeat(64)},page:2};
const asset={sourceVersion:payload.source.version,page:2,mime:'application/pdf',data:bytes.toString('base64'),assetVersion:createHash('sha256').update(bytes).digest('hex')};
const response=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const clientFor=(value,status=200)=>createPaperLibraryClient('http://localhost:43121','paired',async()=>response(value,status));

test('original page sends scoped page request and verifies returned byte digest',async()=>{
 const client=createPaperLibraryClient('http://localhost:43121','paired',async(url,options)=>{
  assert.equal(new URL(url).pathname,'/v1/papers/page');
  assert.equal(options.method,'POST');assert.equal(options.cache,'no-store');
  assert.equal(options.headers['X-Study-Loop-Session'],'paired');
  assert.deepEqual(JSON.parse(options.body),payload);
  return response(asset);
 });
 assert.deepEqual(await client.originalPage(payload),asset);
});

test('original page rejects incomplete open mismatched or corrupt receipts',async()=>{
 const invalid=[null,[],{}, {...asset,page:1},{...asset,page:true},{...asset,sourceVersion:'b'.repeat(64)},{...asset,mime:'image/png'},{...asset,data:bytes.toString('base64')+'!'},{...asset,data:''},{...asset,assetVersion:'0'.repeat(64)},{...asset,assetVersion:asset.assetVersion.toUpperCase()},{...asset,url:'https://other.example/paper.pdf'}];
 for(const receipt of invalid)await assert.rejects(clientFor(receipt).originalPage(payload));
 const nonPdf=Buffer.from('not a PDF');
 await assert.rejects(clientFor({...asset,data:nonPdf.toString('base64'),assetVersion:createHash('sha256').update(nonPdf).digest('hex')}).originalPage(payload));
});

test('old Companion explicitly reports original page capability unavailable',async()=>{
 await assert.rejects(clientFor({message:'Not found'},404).originalPage(payload),/更新 Companion.*原页/);
 const oldService=createPaperLibraryClient('http://localhost:43121','paired',async()=>new Response('Not found',{status:404}));
 await assert.rejects(oldService.originalPage(payload),/更新 Companion.*原页/);
 await assert.rejects(clientFor({message:'paper-original-page-unavailable'},400).originalPage(payload),/原页.*不可用/);
});

test('cancellation rejects even when transport delivers a late receipt',async()=>{
 let complete;const controller=new AbortController();
 const client=createPaperLibraryClient('http://localhost:43121','paired',async()=>new Promise(resolve=>{complete=resolve;}));
 const pending=client.originalPage(payload,controller.signal);
 controller.abort();complete(response(asset));
 await assert.rejects(pending,{name:'AbortError'});
});

test('request identity is captured before caller mutation and independent pages cannot cross',async()=>{
 let complete;const input=structuredClone(payload);
 const client=createPaperLibraryClient('http://localhost:43121','paired',async()=>new Promise(resolve=>{complete=resolve;}));
 const pending=client.originalPage(input);
 input.page=1;input.source.version='b'.repeat(64);complete(response(asset));
 assert.deepEqual(await pending,asset);
 const first=clientFor({...asset,page:1}).originalPage(payload);
 await assert.rejects(first);
});

test('invalid page scope and unsupported origins are rejected before transport',async()=>{
 let calls=0;const client=createPaperLibraryClient('http://localhost:43121','paired',async()=>{calls++;return response(asset);});
 for(const change of [{page:0},{page:201},{page:1.5},{localLibraryId:''},{source:{kind:'upload',filename:'paper.pdf',version:payload.source.version}},{source:{...payload.source,path:'../outside.pdf'}},{source:{...payload.source,path:'https://example.com/paper.pdf'}}])await assert.rejects(client.originalPage({...payload,...change}));
 assert.equal(calls,0);
});

test('normal sized original page assets remain verified and oversized base64 is rejected',async()=>{
 const large=Buffer.from('%PDF-1.7\n'+'x'.repeat(512_000));
 const receipt={...asset,data:large.toString('base64'),assetVersion:createHash('sha256').update(large).digest('hex')};
 assert.deepEqual(await clientFor(receipt).originalPage(payload),receipt);
 await assert.rejects(clientFor({...asset,data:'A'.repeat(Math.ceil(20_000_000/3)*4+4)}).originalPage(payload));
});
