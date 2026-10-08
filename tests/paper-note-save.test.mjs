import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {openPaperDraft} from '../app/paper-draft-store.ts';
import {DEMO_PAPER_ALEXNET} from '../app/paper-study.ts';
import {savePaperNote} from '../app/paper-note-save.ts';
import {PaperLibraryError} from '../app/paper-library-client.ts';
test('remounted callers share one pending request and preserve edits made during preflight',async()=>{
 globalThis.indexedDB=new IDBFactory();const session=await openPaperDraft('qa-note','local',DEMO_PAPER_ALEXNET);await session.flush();await session.update(d=>({...d,slots:{motivation:'original'}}));
 let ready;const gate=new Promise(resolve=>{ready=resolve;});const requests=[];
 const client={catalog:()=>gate,save:async p=>{requests.push(p);return{requestId:p.requestId,localLibraryId:'local',kind:'obsidian',status:'written',path:'notes/one.md'};}};
 const options={client,expected:{localLibraryId:'local'},selection:'obsidian',directory:'notes'};
 const first=savePaperNote(session,DEMO_PAPER_ALEXNET,options),second=savePaperNote(session,DEMO_PAPER_ALEXNET,options);assert.equal(first,second);
 await new Promise(resolve=>setTimeout(resolve,0));await session.update(d=>({...d,slots:{motivation:'newer edit'}}));ready({localLibraryId:'local',accountLibraryId:null,destinations:[]});await first;
 assert.equal(requests.length,1);assert.match(requests[0].markdown,/original/);assert.ok(!requests[0].markdown.includes('newer edit'));assert.equal(session.snapshot().draft.slots.motivation,'newer edit');assert.equal(session.snapshot().draft.pendingNote,undefined);
});
test('uncertain saves retain their immutable request while confirmed no-write can be corrected',async()=>{
 globalThis.indexedDB=new IDBFactory();const session=await openPaperDraft('qa-note-errors','local',DEMO_PAPER_ALEXNET);await session.flush();const requests=[];let uncertain=true;
 const client={catalog:async()=>({localLibraryId:'local',destinations:[]}),save:async p=>{requests.push(p);throw new PaperLibraryError('not saved',!uncertain);}};
 const options={client,expected:{localLibraryId:'local'},selection:'obsidian',directory:'notes'};
 await assert.rejects(savePaperNote(session,DEMO_PAPER_ALEXNET,options));assert.ok(session.snapshot().draft.pendingNote);uncertain=false;await assert.rejects(savePaperNote(session,DEMO_PAPER_ALEXNET,options));assert.equal(requests[0].requestId,requests[1].requestId);assert.equal(session.snapshot().draft.pendingNote,undefined);
});
