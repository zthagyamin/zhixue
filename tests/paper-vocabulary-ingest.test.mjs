import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {openPaperDraft} from '../app/paper-draft-store.ts';
import {DEMO_PAPER_ALEXNET,selectPaperRange} from '../app/paper-study.ts';
import {PaperVocabularyError} from '../app/paper-vocabulary-client.ts';
import {ingestPaperVocabulary,paperVocabularyReceiptMessage,matchPaperVocabulary} from '../app/paper-vocabulary-ingest.ts';

let serial=0;
const paper=DEMO_PAPER_ALEXNET;
function word(term='gradient descent'){
  const paragraph=paper.sections[0].paragraphs[1],start=paragraph.rawEn.indexOf(term);
  const value=selectPaperRange(paper,paragraph.id,start,start+term.length);
  return {...value,meaning:value.meaning||'语境释义'};
}
async function fixture(){
  globalThis.indexedDB=new IDBFactory();
  const owner='qa-ingest-'+(++serial),session=await openPaperDraft(owner,'local',paper);
  await session.flush();await session.update(d=>({...d,selected:[word()]}));await session.flush();
  const calls=[];
  const target={localLibraryId:'local',accountLibraryId:null,revision:'a'.repeat(64),target:'01 学习/学术英语词库/00 学术阅读词卡库.md'};
  const receipt=p=>({requestId:p.requestId,localLibraryId:p.localLibraryId,gatewayRecognized:true,results:p.entries.map(e=>({id:e.id,status:'added'}))});
  const client={target:async()=>target,append:async p=>{calls.push(structuredClone(p));return receipt(p);}};
  return {session,owner,calls,receipt,target,client,options:{owner,expected:{localLibraryId:'local'},client}};
}
const tick=()=>new Promise(resolve=>setTimeout(resolve,0));

test('single and tray entry points share one flight and preserve edits made during preflight',async()=>{
  const f=await fixture();let ready;f.client.target=()=>new Promise(resolve=>{ready=()=>resolve(f.target);});
  const first=ingestPaperVocabulary(f.session,{...f.options,entryIds:[word().id]});
  const second=ingestPaperVocabulary(f.session,f.options);assert.equal(first,second);
  assert.equal(f.session.isExclusive('vocabulary-ingest'),true);
  await tick();await f.session.update(d=>({...d,selected:[{...d.selected[0],meaning:'修改后的意思'},word('non-saturating')]}));ready();
  const result=await first;
  assert.equal(f.calls.length,1);assert.equal(result.request.entries.length,1);
  assert.equal(result.request.entries[0].meaning,word().meaning);
  assert.equal(f.session.snapshot().draft.selected.length,2);
  assert.equal(f.session.snapshot().draft.selected[0].meaning,'修改后的意思');
  assert.equal(f.session.snapshot().draft.ingestedVocabulary[0].meaning,word().meaning);
  assert.equal(f.session.isExclusive('vocabulary-ingest'),false);
});
test('a single-word submission does not send or remove other tray entries',async()=>{
  const f=await fixture(),other=word('non-saturating');await f.session.update(d=>({...d,selected:[...d.selected,other]}));
  const result=await ingestPaperVocabulary(f.session,{...f.options,entryIds:[other.id]});
  assert.deepEqual(result.request.entries.map(e=>e.id),[other.id]);
  assert.deepEqual(f.session.snapshot().draft.selected.map(e=>e.id),[word().id]);
  assert.equal(f.session.snapshot().draft.pending,undefined);
});
test('unknown results keep the immutable request; only explicit retry resends it',async()=>{
  const f=await fixture();let lose=true;f.client.append=async p=>{f.calls.push(structuredClone(p));if(lose)throw new Error('network lost');return f.receipt(p);};
  await assert.rejects(ingestPaperVocabulary(f.session,f.options),/network lost/);
  const saved=structuredClone(f.session.snapshot().draft.pending);assert.ok(saved);
  await f.session.update(d=>({...d,selected:[{...d.selected[0],meaning:'new edit'}]}));
  await assert.rejects(ingestPaperVocabulary(f.session,f.options),/待确认/);
  lose=false;await ingestPaperVocabulary(f.session,{...f.options,retry:true});
  assert.deepEqual(f.calls,[saved,saved]);assert.equal(f.session.snapshot().draft.selected[0].meaning,'new edit');
});
test('confirmed no-write rejection clears only the attempted pending request',async()=>{
  const f=await fixture();f.client.append=async()=>{throw new PaperVocabularyError('vocabulary-stale-revision',409);};
  await assert.rejects(ingestPaperVocabulary(f.session,f.options));
  assert.equal(f.session.snapshot().draft.pending,undefined);assert.equal(f.session.snapshot().draft.selected.length,1);
  f.client.append=async()=>{await f.session.update(d=>({...d,pending:{...d.pending,requestId:'a-new-request'}}));throw new PaperVocabularyError('vocabulary-stale-revision',409);};
  await assert.rejects(ingestPaperVocabulary(f.session,f.options));
  assert.equal(f.session.snapshot().draft.pending.requestId,'a-new-request');
});
test('library mismatch, lost scope and invalid occurrence all stop before append',async()=>{
  const f=await fixture();
  await assert.rejects(ingestPaperVocabulary(f.session,{...f.options,expected:{localLibraryId:'different'}}),/资料库/);
  await assert.rejects(ingestPaperVocabulary(f.session,{...f.options,isCurrent:()=>false}),/已变化/);
  await assert.rejects(ingestPaperVocabulary(f.session,{...f.options,owner:'other'}),/已变化/);
  await f.session.update(d=>({...d,selected:[{...d.selected[0],context:'invented context'}]}));
  await assert.rejects(ingestPaperVocabulary(f.session,f.options),/原句/);
  assert.equal(f.calls.length,0);assert.equal(f.session.snapshot().draft.pending,undefined);
});
test('scope change during target lookup prevents dispatch',async()=>{
  const f=await fixture();let current=true;f.client.target=async()=>{current=false;return f.target;};
  await assert.rejects(ingestPaperVocabulary(f.session,{...f.options,isCurrent:()=>current}),/已变化/);
  assert.equal(f.calls.length,0);
});
test('source material preflight remaps the captured request without overwriting newer source edits',async()=>{
  const f=await fixture();await f.session.update(d=>({...d,selected:[{...d.selected[0],sourceNote:''}]}));
  const libraryClient={catalog:async()=>({localLibraryId:'local',accountLibraryId:null}),material:async()=>{
    await f.session.update(d=>({...d,sourceNoteOverride:'manually-changed.md',selected:d.selected.map(e=>({...e,sourceNote:'manually-changed.md',meaning:'new'}))}));
    return{localLibraryId:'local',sourceNote:'material/snapshot.md'};
  }};
  await ingestPaperVocabulary(f.session,{...f.options,libraryClient});
  assert.equal(f.calls[0].entries[0].sourceNote,'material/snapshot.md');
  assert.equal(f.session.snapshot().draft.sourceNoteOverride,'manually-changed.md');
  assert.equal(f.session.snapshot().draft.selected[0].sourceNote,'manually-changed.md');
});
test('invalid receipts remain pending and conflicts do not remove selected words',async()=>{
  const f=await fixture();f.client.append=async p=>({...f.receipt(p),requestId:'other'});
  await assert.rejects(ingestPaperVocabulary(f.session,f.options),/回执/);assert.ok(f.session.snapshot().draft.pending);
  f.client.append=async p=>({...f.receipt(p),gatewayRecognized:false,results:p.entries.map(e=>({id:e.id,status:'conflict'}))});
  const result=await ingestPaperVocabulary(f.session,{...f.options,retry:true});
  assert.equal(f.session.snapshot().draft.selected.length,1);assert.equal(f.session.snapshot().draft.ingestedVocabulary.length,0);
  assert.match(paperVocabularyReceiptMessage(result.receipt),/待核对/);
  assert.doesNotMatch(paperVocabularyReceiptMessage(result.receipt),/已写入/);
});
test('missing client and blank meanings preserve the selected draft without writing',async()=>{
  const f=await fixture();await assert.rejects(ingestPaperVocabulary(f.session,{...f.options,client:undefined}),/Companion/);
  await f.session.update(d=>({...d,selected:d.selected.map(e=>({...e,meaning:''}))}));
  await assert.rejects(ingestPaperVocabulary(f.session,f.options),/释义/);
  assert.equal(f.calls.length,0);assert.equal(f.session.snapshot().draft.selected.length,1);
});
test('readback requires canonical identity and matching term and meaning, not just a successful refresh',()=>{
  const entry=word(),items=[{itemKey:'word:gradient-descent',word:entry.term,meaning:entry.meaning}];
  assert.deepEqual(matchPaperVocabulary([entry],items),{matched:1,total:1,itemKeys:['word:gradient-descent']});
  assert.equal(matchPaperVocabulary([entry],[{...items[0],meaning:'another sense'}]).matched,0);
  assert.equal(matchPaperVocabulary([entry],[{...items[0],itemKey:''}]).matched,0);
});
