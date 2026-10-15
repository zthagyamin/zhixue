import test from 'node:test';
import assert from 'node:assert/strict';
import {openD1} from './helpers/sqlite-d1.mjs';
import {D1PaperReadingStore} from '../src/infrastructure/paper-reading/d1-store.ts';
import {createAccountStudyApplication} from '../src/application/account-study/index.ts';

async function fixture(t){
 const db=await openD1();t.after(()=>db.sqlite.close());
 db.sqlite.exec("INSERT INTO learning_accounts(user_id) VALUES ('discover-u'),('other-u'); INSERT INTO account_study_libraries(user_id,library_id) VALUES ('discover-u','discover-l'),('other-u','discover-l');");
 const store=new D1PaperReadingStore(db.binding),scope={ownerId:'account:discover-u',libraryId:'account:discover-l'};
 const unit={schemaVersion:1,unitId:'saved-prepared-unit',title:'Original paper',goal:'Explain',source:{...scope,
  materialFingerprint:'a'.repeat(64),sourceVersion:'b'.repeat(64),sectionId:'section',paragraphs:[{id:'original-p',rawEn:'Original material.'}]}};
 await store.mutate(scope,{schemaVersion:1,operationId:'r',unitId:unit.unitId,expectedRevision:0,kind:'register',unit});
 const app=createAccountStudyApplication({getAccessStore:async()=>({profile:async()=>({libraryId:'discover-l',revision:1})}),
  getPaperReadingStore:async()=>store,getAiStore:async()=>{throw Error('Discovery must never call models');}});
 const post=(body,principal={kind:'browser',userId:'discover-u'})=>app.post(structuredClone(body),{principal},new AbortController().signal);
 return {post,store};
}
test('actual dispatcher discovers owner/library records without requiring a local material or prepared pointer',async t=>{
 const f=await fixture(t),response=await f.post({action:'list-paper-reading',limit:1});
 assert.equal(response.status,200);assert.equal(response.value.items[0].unitId,'saved-prepared-unit');
 assert.equal(response.value.nextCursor,null);assert.deepEqual(response.value.scope,{ownerId:'account:discover-u',libraryId:'account:discover-l'});
 assert.deepEqual((await f.post({action:'list-paper-reading'},{kind:'browser',userId:'other-u'})).value.items,[]);
 assert.equal((await f.post({action:'read-paper-reading',unitId:response.value.items[0].unitId})).value.workspace.unit.source.paragraphs[0].rawEn,'Original material.');
});
test('list authentication rejects devices, cross-account hints, foreign libraries and owner/reference/grade fields',async t=>{
 const f=await fixture(t);
 await assert.rejects(f.post({action:'list-paper-reading'},{kind:'device',userId:'discover-u',libraryId:'discover-l',state:'active'}),/action-not-allowed/);
 await assert.rejects(f.post({action:'list-paper-reading',expectedUserId:'other-u'}),/account-mismatch/);
 await assert.rejects(f.post({action:'list-paper-reading',libraryId:'other-l'}),/library-mismatch/);
 for(const extra of [{ownerId:'other-u'},{reference:'forged'},{rating:'good'},{limit:true},{limit:51}])
  await assert.rejects(f.post({action:'list-paper-reading',...extra}),/invalid|discovery/);
});
test('repositories without the optional list capability remain readable and report discovery unsupported',async()=>{
 const app=createAccountStudyApplication({getAccessStore:async()=>({profile:async()=>({libraryId:'l',revision:1})}),
  getPaperReadingStore:async()=>({supported:async()=>true,read:async()=>null})});
 const auth={principal:{kind:'browser',userId:'u'}},signal=new AbortController().signal;
 await assert.rejects(app.post({action:'list-paper-reading'},auth,signal),error=>error.message==='paper-reading-discovery-unsupported'&&error.status===503);
 assert.deepEqual((await app.post({action:'read-paper-reading',unitId:'known-unit'},auth,signal)).value,{workspace:null});
});
