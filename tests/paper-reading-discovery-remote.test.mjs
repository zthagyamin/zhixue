import test from 'node:test';
import assert from 'node:assert/strict';
import {createPaperReadingRemote} from '../src/infrastructure/paper-reading/remote.ts';
import {applyPaperReadingMutation} from '../src/domain/paper-reading/workspace.ts';
import {paperReadingDiscoverySummary,paperReadingDiscoveryCursor} from '../src/domain/paper-reading/discovery.ts';
const scope={ownerId:'account:u',libraryId:'account:l'};
const unit={schemaVersion:1,unitId:'unit',title:'Paper',goal:'Explain',source:{...scope,materialFingerprint:'a'.repeat(64),
 sourceVersion:'b'.repeat(64),sectionId:'s',paragraphs:[{id:'p',rawEn:'Original source.'}]}};
const workspace=applyPaperReadingMutation(null,{schemaVersion:1,kind:'register',unitId:'unit',operationId:'r',expectedRevision:0,unit}).workspace;
const summary=paperReadingDiscoverySummary(workspace),page={schemaVersion:1,scope,items:[summary],nextCursor:null};
test('remote discovery sends authenticated scope and validates summaries without loading answers',async()=>{
 let sent;const remote=createPaperReadingRemote({scope,fetcher:async(_url,init)=>{sent=JSON.parse(init.body);return Response.json(page);}});
 assert.deepEqual(await remote.list({limit:1}),page);
 assert.deepEqual(sent,{limit:1,action:'list-paper-reading',expectedUserId:'u',libraryId:'l'});
});
test('foreign/malformed/answer-bearing pages and invalid continuations cannot become discovery results',async()=>{
 const bad=[{...page,scope:{...scope,ownerId:'account:other'}},{...page,items:[{...summary,answer:'private'}]},
  {...page,items:[{...summary,sourceVersion:['b'.repeat(64)]}]},{...page,items:[summary,summary]},
  {...page,nextCursor:paperReadingDiscoveryCursor(scope,'earlier')},{...page,items:[],nextCursor:paperReadingDiscoveryCursor(scope,'unit')}];
 for(const value of bad)await assert.rejects(createPaperReadingRemote({scope,fetcher:async()=>Response.json(value)}).list(),/binding|field|cursor|source/);
 let calls=0;const remote=createPaperReadingRemote({scope,fetcher:async()=>{calls++;return Response.json(page);}});
 await assert.rejects(remote.list({cursor:paperReadingDiscoveryCursor({...scope,libraryId:'account:other'},'unit')}),/binding/);assert.equal(calls,0);
});
test('old services and late cancelled discovery responses are explicit limitations',async()=>{
 await assert.rejects(createPaperReadingRemote({scope,fetcher:async()=>new Response('Not found',{status:404})}).list(),/unsupported/);
 let current=true;const late=createPaperReadingRemote({scope,isCurrent:()=>current,fetcher:async()=>{current=false;return Response.json(page);}});
 await assert.rejects(late.list(),/cancel/);
});
