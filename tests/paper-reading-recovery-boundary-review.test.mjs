import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory,IDBKeyRange} from 'fake-indexeddb';
import {createHooks,extract,nodes,text,deferred,tick,waitForObservation} from './helpers/causal-harness.mjs';
import {createPaperReadingRecoveryService} from '../app/paper-reading/recovery.ts';
import {parsePaperStudyData} from '../app/paper-study.ts';
import {openPaperDraft,savePaperMaterial,loadPaperMaterials} from '../app/paper-draft-store.ts';
import {openStudyDb} from '../app/local-study-db.ts';

function reset(){globalThis.indexedDB=new IDBFactory();globalThis.IDBKeyRange=IDBKeyRange;}
const paper=title=>parsePaperStudyData({paperId:title,title,sections:[{id:'s',title:'Section',paragraphs:[{id:'p',rawEn:'Original source paragraph.'}]}]});
test('legacy embedded paper is an intact recovery source even when only the current upload is in the materials index',async()=>{
 reset();const scope={ownerId:'account:review-legacy-backup',libraryId:'local:review-legacy-backup'};
 const old=paper('Previous demo'),current=paper('Current upload');
 const draft=await openPaperDraft(scope.ownerId,scope.libraryId,old);await draft.flush();
 await draft.update(value=>({...value,summaries:{p:'My original demo notes.'}}));await draft.flush();
 await savePaperMaterial(scope.ownerId,scope.libraryId,current);
 const artifact=await createPaperReadingRecoveryService(scope).export();
 assert.equal(artifact.complete,true);assert.equal(artifact.records.length,2);
 assert.equal(artifact.records.find(r=>r.type==='draft').value.draft.summaries.p,'My original demo notes.');
 assert.deepEqual(artifact.records.find(r=>r.type==='materials').value.map(m=>m.paper.title),['Current upload']);
 assert.deepEqual((await loadPaperMaterials(scope.ownerId,scope.libraryId)).map(m=>m.paper.title),['Current upload']);
});
test('a backup action whose flush resolves after unmount cannot run the material-writing export callback',async()=>{
 reset();const hooks=createHooks(),gate=deferred(),refs=[];
 const scope={ownerId:'account:review-late-backup',libraryId:'local:review-late-backup'};
 let writes=0;const jsx=(type,props)=>({type,props});
 const control=extract('app/paper-reading/backup-controls.tsx','BoundReadingBackupControls')({...hooks.api,
  useRef:initial=>{const ref=hooks.api.useRef(initial);refs.push(ref);return ref;},exports:{},
  createPaperReadingRecoveryService,require:()=>({jsx,jsxs:jsx})});
 hooks.mount(control,{services:{owner:scope.ownerId,library:scope.libraryId,isCurrent:()=>true},beforeChange:()=>gate.promise,
  beforeExport:async()=>{writes++;await savePaperMaterial(scope.ownerId,scope.libraryId,paper('Old reader material'));}});
 hooks.flush();[...nodes(hooks.view())].find(n=>n.type==='button'&&text(n)==='导出阅读备份').props.onClick();
 const flight=refs[1];assert.equal(flight.current,true);hooks.unmount();gate.resolve();
 await waitForObservation(tick,()=>flight.current===false);
 assert.equal(writes,0);assert.deepEqual(await loadPaperMaterials(scope.ownerId,scope.libraryId),[]);
});
test('a legitimate password lexicon term remains learning content rather than being classified as a credential field',async()=>{
 reset();const scope={ownerId:'account:review-lexicon-backup',libraryId:'local:review-lexicon-backup'};
 const material=parsePaperStudyData({paperId:'security-paper',title:'Authentication concepts',sections:[{id:'s',title:'Vocabulary',
  paragraphs:[{id:'p',rawEn:'A password authenticates users.',lexicon:{password:{meaning:'密码：用于身份验证的知识因素。'}}}]}]});
 await savePaperMaterial(scope.ownerId,scope.libraryId,material);
 const artifact=await createPaperReadingRecoveryService(scope).export();
 assert.equal(artifact.records[0].value[0].paper.sections[0].paragraphs[0].lexicon.password.meaning,material.sections[0].paragraphs[0].lexicon.password.meaning);
});
test('the lexicon vocabulary-key exception does not permit credentials nested in a dictionary value',async()=>{
 reset();const scope={ownerId:'account:review-lexicon-secret',libraryId:'local:review-lexicon-secret'};
 const material=parsePaperStudyData({paperId:'security-paper',title:'Authentication concepts',sections:[{id:'s',title:'Vocabulary',
  paragraphs:[{id:'p',rawEn:'A password authenticates users.',lexicon:{password:{meaning:'A vocabulary definition.'}}}]}]});
 await savePaperMaterial(scope.ownerId,scope.libraryId,material);
 const db=await openStudyDb(),tx=db.transaction('workspace-records','readwrite'),store=tx.objectStore('workspace-records');
 const request=store.get(scope.ownerId+':paper-document:'+scope.libraryId);
 request.onsuccess=()=>{const row=request.result;row.value[0].paper.sections[0].paragraphs[0].lexicon.password.apiKey='synthetic forbidden field';store.put(row);};
 await new Promise((resolve,reject)=>{tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});db.close();
 await assert.rejects(createPaperReadingRecoveryService(scope).export(),/credentials-not-allowed/);
});
test('a valid original paragraph ID named secret remains an ordinary legacy summary dictionary key',async()=>{
 reset();const scope={ownerId:'account:review-summary-id',libraryId:'local:review-summary-id'};
 const material=parsePaperStudyData({paperId:'summary-paper',title:'A valid original',sections:[{id:'s',title:'Section',
  paragraphs:[{id:'secret',rawEn:'A secret is confidential information.'}]}]});
 await savePaperMaterial(scope.ownerId,scope.libraryId,material);
 const draft=await openPaperDraft(scope.ownerId,scope.libraryId,material);await draft.flush();
 await draft.update(value=>({...value,summaries:{secret:'My original paragraph summary.'}}));await draft.flush();
 const artifact=await createPaperReadingRecoveryService(scope).export();
 assert.equal(artifact.records.find(row=>row.type==='draft').value.draft.summaries.secret,'My original paragraph summary.');
});
test('a legacy summary dictionary still rejects nested objects and credential-bearing values',async()=>{
 for(const [index,bad] of [{apiKey:'synthetic forbidden field'},{meaning:'An object is not a saved summary string.'}].entries()){
  reset();const scope={ownerId:'account:review-summary-value-'+index,libraryId:'local:review-summary-value'};
  const material=parsePaperStudyData({paperId:'summary-paper',title:'A valid original',sections:[{id:'s',title:'Section',
   paragraphs:[{id:'secret',rawEn:'A secret is confidential information.'}]}]});
  await savePaperMaterial(scope.ownerId,scope.libraryId,material);
  const draft=await openPaperDraft(scope.ownerId,scope.libraryId,material);await draft.flush();
  await draft.update(value=>({...value,summaries:{secret:bad}}));await draft.flush();
  await assert.rejects(createPaperReadingRecoveryService(scope).export(),/credentials-not-allowed|draft-text/);
 }
});
test('a non-paragraph summary key cannot exploit the learning dictionary credential exception',async()=>{
 reset();const scope={ownerId:'account:review-summary-foreign-key',libraryId:'local:review-summary-foreign-key'};
 const material=paper('Only paragraph p is authorized');await savePaperMaterial(scope.ownerId,scope.libraryId,material);
 const draft=await openPaperDraft(scope.ownerId,scope.libraryId,material);await draft.flush();
 await draft.update(value=>({...value,summaries:{apiKey:'synthetic forbidden field outside any source paragraph'}}));await draft.flush();
 await assert.rejects(createPaperReadingRecoveryService(scope).export(),/draft-slot|credentials-not-allowed|draft-source/);
});
