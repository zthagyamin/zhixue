import test from 'node:test';
import assert from 'node:assert/strict';
import {openD1} from './helpers/sqlite-d1.mjs';
import {D1PaperReadingStore} from '../src/infrastructure/paper-reading/d1-store.ts';
import {paperReadingTask} from '../src/domain/paper-reading/evidence.ts';

const scope={ownerId:'account:discover-u',libraryId:'account:discover-l'};
async function fixture(t){
 const db=await openD1();t.after(()=>db.sqlite.close());
 db.sqlite.exec("INSERT INTO learning_accounts(user_id) VALUES ('discover-u'),('other-u'); INSERT INTO account_study_libraries(user_id,library_id) VALUES ('discover-u','discover-l'),('discover-u','other-l'),('other-u','discover-l');");
 return {...db,store:new D1PaperReadingStore(db.binding)};
}
async function register(store,unitId,bound=scope){
 const unit={schemaVersion:1,unitId,title:'Saved paper '+unitId,goal:'Explain mechanism',source:{...bound,
  materialFingerprint:'a'.repeat(64),sourceVersion:'b'.repeat(64),sectionId:'s',paragraphs:[{id:'p',rawEn:'ReLU avoids saturation.',pageNumber:1}]}};
 return (await store.mutate(bound,{schemaVersion:1,kind:'register',unitId,operationId:'register:'+unitId,expectedRevision:0,unit})).workspace;
}
test('D1 discovers every scoped unit across bounded keyset pages without returning answers or references',async t=>{
 const db=await fixture(t);
 for(let i=0;i<55;i++)await register(db.store,'unit-'+String(i).padStart(3,'0'));
 await register(db.store,'other-library',{...scope,libraryId:'account:other-l'});
 await register(db.store,'other-owner',{...scope,ownerId:'account:other-u'});
 let cursor=null,items=[],pages=0;
 do{
  const page=await db.store.list(scope,{cursor,limit:7});
  assert.equal(page.schemaVersion,1);assert.deepEqual(page.scope,scope);assert.ok(page.items.length<=7);
  assert.ok(!JSON.stringify(page).includes('rawEn'));assert.ok(!JSON.stringify(page).includes('submission'));
  items.push(...page.items);cursor=page.nextCursor;pages++;
 }while(cursor!==null);
 assert.equal(pages,8);assert.equal(items.length,55);assert.equal(new Set(items.map(x=>x.unitId)).size,55);
 assert.deepEqual(items.map(x=>x.unitId),Array.from({length:55},(_,i)=>'unit-'+String(i).padStart(3,'0')));
});
test('discovery exposes prepared-task identity while standalone read preserves the exact old answer',async t=>{
 const db=await fixture(t),initial=await register(db.store,'prepared-unit');
 const task=paperReadingTask({taskId:'prepared:saved-recipe',revision:1,source:initial.unit.source,goal:initial.unit.goal,
  origin:'prepared',ability:'mechanism',question:'Why does ReLU help?',reference:[{point:'PRIVATE REFERENCE POINT',paragraphId:'p',quote:'avoids saturation'}]});
 await db.store.writeService(scope,{schemaVersion:1,kind:'task',unitId:'prepared-unit',operationId:'prepare',expectedRevision:1,task});
 const answer='PRIVATE LEARNER ANSWER '.repeat(100);
 await db.store.mutate(scope,{schemaVersion:1,kind:'submit',unitId:'prepared-unit',operationId:'submit',expectedRevision:2,
  answer,submittedAt:'2026-10-08T09:00:00Z',referenceSeen:false});
 const page=await db.store.list(scope,{}),summary=page.items[0];
 assert.equal(summary.task.origin,'prepared');assert.equal(summary.task.taskId,task.taskId);assert.equal(summary.task.revision,1);
 assert.deepEqual(summary.paragraphIds,['p']);assert.equal(summary.materialFingerprint,'a'.repeat(64));
 assert.equal(summary.hasSubmission,true);assert.equal(summary.pendingEvaluation,true);assert.equal(summary.attemptCount,1);
 assert.ok(!JSON.stringify(page).includes('PRIVATE LEARNER ANSWER'));assert.ok(!JSON.stringify(page).includes('PRIVATE REFERENCE POINT'));
 assert.equal((await db.store.read(scope,summary.unitId)).attempts[0].submission.answer,answer);
});
test('scope-closed cursors and strict paging values cannot cross account or library',async t=>{
 const db=await fixture(t);await register(db.store,'a');await register(db.store,'b');
 const page=await db.store.list(scope,{limit:1});assert.ok(page.nextCursor);
 await assert.rejects(db.store.list({...scope,libraryId:'account:other-l'},{cursor:page.nextCursor}),/cursor.*binding|scope/);
 await assert.rejects(db.store.list({...scope,ownerId:'account:other-u'},{cursor:page.nextCursor}),/cursor.*binding|scope/);
 for(const query of [{limit:0},{limit:51},{limit:true},{cursor:'broken'},{ownerId:'other'}])await assert.rejects(db.store.list(scope,query),/discovery|cursor|scope/);
});
test('a corrupt stored row is rejected rather than silently omitted from discovery',async t=>{
 const db=await fixture(t);await register(db.store,'corrupt');
 db.sqlite.prepare('UPDATE paper_reading_workspaces_v1 SET revision=99 WHERE unit_id=?').run('corrupt');
 await assert.rejects(db.store.list(scope,{}),/corrupt|revision/);
});
test('a missing migration is explicitly unsupported for discovery',async t=>{
 const db=await fixture(t);db.sqlite.exec('DROP TABLE paper_reading_workspaces_v1');
 await assert.rejects(db.store.list(scope,{}),/unsupported/);
});
test('Unicode unit IDs use the same stable cursor order as SQLite BINARY',async t=>{
 const db=await fixture(t),ids=['unit-a','unit-\ue001','unit-😀'];
 for(const id of ids)await register(db.store,id);
 const found=[];let cursor=null;
 do{const page=await db.store.list(scope,{cursor,limit:1});found.push(...page.items.map(x=>x.unitId));cursor=page.nextCursor;}while(cursor);
 assert.deepEqual(found,ids);
});
test('scope and query are captured before asynchronous discovery work',async t=>{
 const db=await fixture(t);await register(db.store,'a');await register(db.store,'b');
 let release;const original=db.store.supported.bind(db.store),gate=new Promise(resolve=>{release=resolve;});
 db.store.supported=async()=>{await gate;return original();};
 const caller={...scope},query={limit:1},pending=db.store.list(caller,query);
 caller.ownerId='account:other-u';query.limit=50;release();
 const page=await pending;assert.deepEqual(page.scope,scope);assert.equal(page.items.length,1);assert.ok(page.nextCursor);
});
test('response-size bounds preserve a continuation instead of silently dropping matching records',async t=>{
 const db=await fixture(t);
 for(let n=0;n<6;n++){
  const unitId='large-'+n,unit={schemaVersion:1,unitId,title:'Large identifier set',goal:'Explain',source:{...scope,
   materialFingerprint:'a'.repeat(64),sourceVersion:'b'.repeat(64),sectionId:'s',
   paragraphs:Array.from({length:500},(_,i)=>({id:'p'+String(i).padStart(4,'0')+'x'.repeat(394),rawEn:'x'}))}};
  await db.store.mutate(scope,{schemaVersion:1,kind:'register',unitId,operationId:'r'+n,expectedRevision:0,unit});
 }
 const first=await db.store.list(scope,{limit:50});assert.ok(first.items.length<6);assert.ok(first.nextCursor);
 const second=await db.store.list(scope,{limit:50,cursor:first.nextCursor});
 assert.equal(first.items.length+second.items.length,6);assert.equal(second.nextCursor,null);
});
