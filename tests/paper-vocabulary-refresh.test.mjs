import test from 'node:test';
import assert from 'node:assert/strict';
import {dashboardDeclaredFunction} from './fixtures/dashboard-functions.mjs';
import {matchPaperVocabulary,PAPER_VOCABULARY_TARGET} from '../app/paper-vocabulary-ingest.ts';
import {tsxFunction} from './fixtures/tsx-functions.mjs';

const entry={term:'gradient descent',meaning:'梯度下降'};
const localItem={abilityId:'word:academic:gradient-descent',word:entry.term,meaning:entry.meaning,sourceNote:PAPER_VOCABULARY_TARGET};
function fixture(account=false){
  const source={localLibraryId:'local',subjects:[{items:[localItem]}]},applied=[],calls=[];
  const bundle={snapshot:{libraryId:'account-library',snapshotId:'new'},items:[{kind:'word',itemKey:localItem.abilityId,word:{word:entry.term,meaning:entry.meaning}}]};
  const b={workspaceId:'owner',taskWorkspaceRef:{current:'owner'},accountModeEpoch:{current:0},accountLibraryId:account?'account-library':null,paperScopeCurrent:()=>true,
    companionSession:{},companionUrl:'http://localhost:43121',companionHeaders:{},PAPER_VOCABULARY_TARGET,matchPaperVocabulary,
    fetch:async(url,options)=>{calls.push({url,options});return Response.json(source);},
    refreshAccountRead:async()=>({bundle}),accountLoadedRef:{current:account?{bundle}:null},accountPendingLoadedRef:{current:null},
    applyLocalStudySource:(value,owner)=>{applied.push({value,owner});return true;}};
  return{b,source,bundle,applied,calls,run:()=>dashboardDeclaredFunction('refreshPaperVocabulary',b)([entry],'local')};
}
test('native readback applies canonical refreshed data and reports actual membership',async()=>{
  const f=fixture(),result=await f.run();assert.equal(result.status,'visible');assert.deepEqual(result.itemKeys,[localItem.abilityId]);
  assert.equal(f.applied.length,1);assert.equal(f.calls[0].options.method,undefined);assert.ok(f.calls[0].url.endsWith('/v1/study-data'));
});
test('same word from another source does not claim the academic target was read back',async()=>{
  const f=fixture();f.source.subjects[0].items=[{...localItem,sourceNote:'other.md'}];
  assert.equal((await f.run()).status,'pending');
});
test('source or owner changes during readback never replace the current page data',async()=>{
  const f=fixture();f.source.localLibraryId='another';await assert.rejects(f.run(),/未完整核对/);assert.equal(f.applied.length,0);
  const g=fixture();g.b.fetch=async()=>{g.b.accountModeEpoch.current++;return Response.json(g.source);};await assert.rejects(g.run(),/资料库已变化/);assert.equal(g.applied.length,0);
});
test('a current practice defers native material refresh instead of changing its question',async()=>{
  const f=fixture();f.b.applyLocalStudySource=()=>false;assert.equal((await f.run()).status,'deferred');
});
test('account readback waits for the identical canonical key and never inserts native questions',async()=>{
  const f=fixture(true);f.bundle.items[0].itemKey='word:other:gradient-descent';assert.equal((await f.run()).status,'pending');assert.equal(f.applied.length,0);
  f.bundle.items[0].itemKey=localItem.abilityId;assert.equal((await f.run()).status,'visible');
});
test('verified account snapshot held for the current attempt is reported as deferred',async()=>{
  const f=fixture(true);f.b.accountLoadedRef.current={bundle:{snapshot:{libraryId:'account-library',snapshotId:'old'},items:[]}};f.b.accountPendingLoadedRef.current={bundle:f.bundle};
  assert.equal((await f.run()).status,'deferred');
});
test('an earlier readback cannot clear the newer readback indicator or replace its result',async()=>{
  const gates=[],checking=[],results=[];
  const refresh=tsxFunction(new URL('../app/plugins/plugin-paper.tsx',import.meta.url),'refreshVocabulary',{
    services:{refreshVocabulary:()=>new Promise(resolve=>gates.push(resolve))},alive:{current:true},readbackRun:{current:0},
    session:{snapshot:()=>({draft:{receipt:{requestId:'same'}}})},setCheckingVocabulary:value=>checking.push(value),setReadback:value=>results.push(value),
  });
  const receipt={requestId:'same',localLibraryId:'local'};
  const first=refresh([entry],receipt),second=refresh([entry],receipt);
  gates[0]({status:'pending'});await first;
  assert.equal(checking.at(-1),true);assert.equal(results.length,0);
  gates[1]({status:'visible'});await second;
  assert.equal(checking.at(-1),false);assert.equal(results[0].value.status,'visible');
});
