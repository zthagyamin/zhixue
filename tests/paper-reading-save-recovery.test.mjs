import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {createPaperReadingSession} from '../src/application/paper-reading/session.ts';
import {createPaperReadingStore} from '../app/paper-reading/store.ts';
import {paperReadingTask} from '../src/domain/paper-reading/evidence.ts';
import {loadTsx} from './fixtures/tsx-components.mjs';
import {button,createHooks,extract,deferred,tick,waitForObservation,nodes,text} from './helpers/causal-harness.mjs';
const {PaperReadingQuestion}=loadTsx(new URL('../src/features/paper-reading/question.tsx',import.meta.url));
const scope={ownerId:'account:save-recovery',libraryId:'local:save-recovery'};
const unit={schemaVersion:1,unitId:'recovery-unit',title:'Paper',goal:'Explain mechanism',source:{...scope,materialFingerprint:'a'.repeat(64),sourceVersion:'b'.repeat(64),sectionId:'s',paragraphs:[{id:'p',rawEn:'ReLU avoids saturation for positive inputs.'}]}};
const task=()=>paperReadingTask({taskId:'task',revision:1,source:unit.source,goal:unit.goal,origin:'prepared',ability:'mechanism',question:'Why does ReLU help?',reference:[{point:'Avoid saturation.',paragraphId:'p',quote:'avoids saturation'}]});
async function fixture(intercept=(write)=>write(),extra={},interceptRead=read=>read()){
 globalThis.indexedDB=new IDBFactory();let serial=0;const base=createPaperReadingStore(),writes=[];
 const store={...base,read:(...args)=>interceptRead(()=>base.read(...args)),mutate:async(bound,mutation)=>{writes.push(structuredClone(mutation));return intercept(()=>base.mutate(bound,mutation),mutation);}};
 const session=createPaperReadingSession({unit,store,makeId:()=>`save-op-${++serial}`,now:()=>new Date('2026-10-26T09:00:00Z'),...extra});
 await session.load();await session.begin(task());await session.answer('Original answer');await session.submit();
 const props={onBegin(){},onAnswer(){},onSubmit(){},onReveal(){},onRetry(){},onEvaluate(){},onSync(){},onContinue(){},onRetrySave:()=>session.retrySave(),onReloadSaved:()=>session.reloadSaved(),onAdoptSavedAnswer:()=>session.adoptSavedAnswer(),renderText:text=>text};
 return {base,session,writes,view:()=>PaperReadingQuestion({...props,state:session.snapshot()})};
}
test('submitted reference failure offers an enabled in-page save retry and preserves the original answer',async()=>{
 let failing=true;const f=await fixture((write,m)=>{if(m.kind==='reference'&&failing)throw Error('quota');return write();});
 await assert.rejects(f.session.reveal(),/quota/);
 assert.equal(button(f.view(),'继续').props.disabled,true);
 const retry=button(f.view(),'重试保存');assert.ok(retry,'save failure must expose a recovery button');assert.equal(retry.props.disabled,false);
 failing=false;await retry.props.onClick();await f.session.flush();
 assert.equal(f.session.snapshot().workspace.referenceSeen,true);assert.equal(f.session.snapshot().workspace.attempts[0].submission.answer,'Original answer');
 assert.equal(button(f.view(),'继续').props.disabled,false);assert.deepEqual(f.writes.at(-1),f.writes.at(-2));
 assert.equal(f.session.snapshot().workspace.operations.filter(m=>m.kind==='reference').length,1);
});
async function submittedConflict(extra,interceptRead){
 let fail=false;const f=await fixture((write,m)=>{if(fail&&m.kind==='draft')throw Error('quota');return write();},extra,interceptRead);
 await f.session.retry();fail=true;await assert.rejects(f.session.answer('Local unsubmitted text'),/quota/);
 const saved=await f.base.read(scope,unit.unitId);
 await f.base.mutate(scope,{schemaVersion:1,operationId:'external-submit',unitId:unit.unitId,expectedRevision:saved.revision,kind:'submit',answer:'External submitted answer',referenceSeen:false,submittedAt:'2026-10-26T09:01:00Z'});
 fail=false;await assert.rejects(f.session.retrySave(),/conflict/);await f.session.reloadSaved();return f;
}
test('a submitted conflict displays both answers and offers adoption without discarding local input or writing an event',async()=>{
 const f=await submittedConflict();const view=f.view();
 assert.ok([...nodes(view)].some(n=>n.type==='label'&&text(n)==='已保存的提交回答'));
 assert.ok([...nodes(view)].some(n=>n.type==='textarea'&&n.props.value==='External submitted answer'&&n.props.readOnly));
 assert.ok([...nodes(view)].some(n=>n.type==='textarea'&&n.props['aria-label']==='本页未保存输入'&&n.props.value==='Local unsubmitted text'));
 const adopt=button(view,'保留本页输入，使用已保存回答');assert.ok(adopt);assert.equal(adopt.props.disabled,false);
 const before=await f.base.read(scope,unit.unitId),writes=f.writes.length;await adopt.props.onClick();await f.session.flush();
 assert.equal(f.session.snapshot().input,'External submitted answer');assert.equal(f.session.snapshot().unsavedInput,'Local unsubmitted text');
 assert.equal(f.session.snapshot().error,'');assert.equal(button(f.view(),'继续').props.disabled,false);assert.equal(f.writes.length,writes);
 assert.deepEqual(await f.base.read(scope,unit.unitId),before);
 assert.ok([...nodes(f.view())].some(n=>n.type==='textarea'&&n.props['aria-label']==='本页未保存输入'&&n.props.value==='Local unsubmitted text'&&n.props.readOnly));
});
test('an external write after conflict reread invalidates adoption and requires another explicit reread',async()=>{
 const f=await submittedConflict(),saved=await f.base.read(scope,unit.unitId);
 await f.base.mutate(scope,{schemaVersion:1,operationId:'external-new-attempt',unitId:unit.unitId,expectedRevision:saved.revision,kind:'retry',attemptId:'new-external-attempt',purpose:'remediation'});
 await f.session.adoptSavedAnswer();assert.match(f.session.snapshot().error,/conflict/);assert.equal(f.session.snapshot().input,'Local unsubmitted text');
 assert.equal(button(f.view(),'继续').props.disabled,true);assert.ok(button(f.view(),'重新读取已保存内容'));
 assert.equal((await f.base.read(scope,unit.unitId)).activeAttemptId,'new-external-attempt');
});
test('owner retirement or a newer edit while adoption is reading prevents old adoption results',async()=>{
 for(const reason of ['owner','edit']){
  const gate=deferred();let current=true,hold=false,reads=0;
  const f=await submittedConflict({isCurrent:()=>current},async read=>{if(hold){reads++;await gate.promise;}return read();});
  hold=true;const adoption=f.session.adoptSavedAnswer();await waitForObservation(tick,()=>reads===1);
  if(reason==='owner')current=false;else {const edit=f.session.answer('Newer local input');edit.catch(()=>{});}
  const before=f.session.snapshot();gate.resolve();await adoption;
  if(reason==='owner')assert.deepEqual(f.session.snapshot(),before);
  else assert.equal(f.session.snapshot().input,'Newer local input');
 }
});
test('the real question entry adopts the saved answer and releases its guard while keeping local text visible',async()=>{
 const f=await submittedConflict(),hooks=createHooks(),guards=[],errors=[],jsx=(type,props)=>({type,props});
 const QuestionSession=extract('app/paper-reading/question.tsx','QuestionSession')({...hooks.api,
  registerStudyNavigationGuard:guard=>{guards.push(guard);return()=>{};},window:{addEventListener(){},removeEventListener(){}},
  PaperReadingQuestion,PaperReviewCandidate:'Review',PaperSourceText:'Text',MathText:'Math',exports:{},require:()=>({jsx,jsxs:jsx})});
 hooks.mount(QuestionSession,{session:f.session,paper:{},services:{},prepared:null,onSaving(){},onError:error=>errors.push(error),onContinue(){}});hooks.flush();
 assert.ok(guards[0].message());const render=()=>PaperReadingQuestion(hooks.render().props);
 button(render(),'保留本页输入，使用已保存回答').props.onClick();await waitForObservation(tick,()=>!f.session.snapshot().saving&&!f.session.snapshot().error);
 assert.equal(guards[0].message(),null);assert.equal(errors.at(-1),'');assert.equal(button(render(),'继续').props.disabled,false);
 assert.ok([...nodes(render())].some(n=>n.type==='textarea'&&n.props['aria-label']==='本页未保存输入'&&n.props.value==='Local unsubmitted text'));hooks.unmount();
});
test('adoption read failure remains recoverable and duplicate clicks share one confirmation read',async()=>{
 let unavailable=false,reads=0,hold=false;const gate=deferred();
 const f=await submittedConflict({},async read=>{if(unavailable)throw Error('paper-reading-load-unavailable');if(hold){reads++;await gate.promise;}return read();});
 unavailable=true;await f.session.adoptSavedAnswer();assert.match(f.session.snapshot().error,/load-unavailable/);assert.equal(f.session.snapshot().input,'Local unsubmitted text');
 assert.ok(button(f.view(),'保留本页输入，使用已保存回答'));unavailable=false;hold=true;
 const first=f.session.adoptSavedAnswer(),second=f.session.adoptSavedAnswer();await waitForObservation(tick,()=>reads===1);
 assert.equal(button(f.view(),'保留本页输入，使用已保存回答').props.disabled,true);gate.resolve();await first;await second;
 assert.equal(reads,1);assert.equal(f.session.snapshot().unsavedInput,'Local unsubmitted text');await f.session.flush();
});
test('lost durable receipt retries the exact request and accepts duplicate without another journal entry',async()=>{
 let lost=true;const receipts=[];const f=await fixture(async(write,m)=>{const receipt=await write();if(m.kind==='reference'){receipts.push(receipt.status);if(lost){lost=false;throw Error('receipt-unknown');}}return receipt;});
 await assert.rejects(f.session.reveal(),/receipt-unknown/);await f.session.retrySave();
 assert.deepEqual(receipts,['accepted','duplicate']);assert.deepEqual(f.writes.at(-1),f.writes.at(-2));
 assert.equal(f.session.snapshot().workspace.operations.filter(m=>m.kind==='reference').length,1);assert.equal(f.session.snapshot().error,'');
});
test('repeated failure stays recoverable and double clicks share one retry flight',async()=>{
 let gate;const f=await fixture(async(write,m)=>{if(m.kind==='reference'){if(gate)await gate.promise;throw Error('quota');}return write();});
 await assert.rejects(f.session.reveal(),/quota/);gate=deferred();
 const before=f.writes.length,first=f.session.retrySave(),second=f.session.retrySave();const rejected=assert.rejects(first,/quota/),alsoRejected=assert.rejects(second,/quota/);
 assert.equal(button(f.view(),'重试保存').props.disabled,true);await waitForObservation(tick,()=>f.writes.length===before+1);gate.resolve();await rejected;await alsoRejected;
 assert.equal(f.writes.length,before+1);assert.equal(button(f.view(),'重试保存').props.disabled,false);assert.equal(button(f.view(),'继续').props.disabled,true);
});
test('real revision conflict never rebases; explicit reread preserves an unsaved draft',async()=>{
 let failing=false;const f=await fixture((write,m)=>{if(failing&&m.kind==='draft')throw Error('quota');return write();});
 await f.session.retry();failing=true;await assert.rejects(f.session.answer('Unsaved local input'),/quota/);
 const failed=structuredClone(f.writes.at(-1)),stored=await f.base.read(scope,unit.unitId);
 await f.base.mutate(scope,{schemaVersion:1,operationId:'external-draft',unitId:unit.unitId,expectedRevision:stored.revision,kind:'draft',answer:'Saved elsewhere',referenceSeen:false});
 failing=false;await assert.rejects(f.session.retrySave(),/conflict/);
 assert.deepEqual(f.writes.at(-1),failed);assert.equal(f.session.snapshot().saveRecovery,'conflict');
 assert.ok(button(f.view(),'重新读取已保存内容'));await f.session.reloadSaved();
 assert.equal(f.session.snapshot().workspace.answer,'Saved elsewhere');assert.equal(f.session.snapshot().input,'Unsaved local input');await assert.rejects(f.session.flush());
 await f.session.answer('Unsaved local input (reviewed)');await f.session.flush();assert.equal(f.session.snapshot().error,'');
});
test('a newer edit invalidates a held retry result but still saves the latest draft',async()=>{
 const gate=deferred();let fail=true,hold=false;const f=await fixture(async(write,m)=>{if(m.kind==='draft'&&m.answer==='A'){if(fail)throw Error('quota');if(hold)await gate.promise;}return write();});
 await f.session.retry();await assert.rejects(f.session.answer('A'),/quota/);fail=false;hold=true;
 const retry=f.session.retrySave();await tick();const edit=f.session.answer('AB');gate.resolve();await retry;await edit;
 assert.equal(f.session.snapshot().input,'AB');assert.equal(f.session.snapshot().workspace.answer,'AB');assert.equal(f.session.snapshot().saveRecovery,null);await f.session.flush();
});
test('disposed and switched-owner sessions ignore late retry results and cannot start old retries',async()=>{
 for(const invalidation of ['dispose','owner']){
  const gate=deferred();let fail=true,current=true;const f=await fixture(async(write,m)=>{if(m.kind==='reference'){if(fail)throw Error('quota');await gate.promise;}return write();},{isCurrent:()=>current});
  await assert.rejects(f.session.reveal(),/quota/);fail=false;const retry=f.session.retrySave();await tick();
  if(invalidation==='dispose')f.session.dispose();else current=false;
  const before=f.session.snapshot();gate.resolve();await retry;assert.deepEqual(f.session.snapshot(),before);
  const count=f.writes.length;await f.session.retrySave();assert.equal(f.writes.length,count);
 }
});
test('save recovery of a failed remediation preserves its attempt identity and purpose',async()=>{
 let fail=true;const f=await fixture((write,m)=>{if(fail&&m.kind==='retry')throw Error('quota');return write();});
 await assert.rejects(f.session.retry(),/quota/);const mutation=structuredClone(f.writes.at(-1));fail=false;await f.session.retrySave();
 assert.deepEqual(f.writes.at(-1),mutation);assert.equal(f.session.snapshot().workspace.attempts.length,2);
 assert.equal(f.session.snapshot().workspace.attempts[1].attemptId,mutation.attemptId);assert.equal(f.session.snapshot().input,'');
 assert.equal(f.session.snapshot().workspace.attempts[0].submission.answer,'Original answer');
});
test('the real question entry clears navigation and unload protection only after recovery succeeds',async()=>{
 let fail=true;const f=await fixture((write,m)=>{if(fail&&m.kind==='reference')throw Error('quota');return write();});
 const hooks=createHooks(),events=new Map(),errors=[],guards=[],jsx=(type,props)=>({type,props});let continued=0;
 const QuestionSession=extract('app/paper-reading/question.tsx','QuestionSession')({...hooks.api,
  registerStudyNavigationGuard:guard=>{guards.push(guard);return()=>{};},window:{addEventListener:(name,fn)=>events.set(name,fn),removeEventListener:name=>events.delete(name)},
  PaperReadingQuestion,PaperReviewCandidate:'Review',PaperSourceText:'Text',MathText:'Math',exports:{},require:()=>({jsx,jsxs:jsx})});
 hooks.mount(QuestionSession,{session:f.session,paper:{},services:{},prepared:null,onSaving(){},onError:error=>errors.push(error),onContinue:()=>continued++});hooks.flush();
 await assert.rejects(f.session.reveal(),/quota/);assert.match(guards[0].message(),/尚未可靠保存/);assert.equal(errors.at(-1),'quota');
 let prevented=false;events.get('beforeunload')({preventDefault(){prevented=true;}});assert.equal(prevented,true);
 const render=()=>PaperReadingQuestion(hooks.render().props);assert.equal(button(render(),'继续').props.disabled,true);
 fail=false;button(render(),'重试保存').props.onClick();await waitForObservation(tick,()=>!f.session.snapshot().saving&&!f.session.snapshot().error);
 assert.equal(guards[0].message(),null);assert.equal(errors.at(-1),'');button(render(),'继续').props.onClick();assert.equal(continued,1);hooks.unmount();
});
test('rereading a conflict against an externally submitted answer retains and labels the unsaved input',async()=>{
 let fail=false;const f=await fixture((write,m)=>{if(fail&&m.kind==='draft')throw Error('quota');return write();});
 await f.session.retry();fail=true;await assert.rejects(f.session.answer('Local unsubmitted text'),/quota/);
 const saved=await f.base.read(scope,unit.unitId);
 await f.base.mutate(scope,{schemaVersion:1,operationId:'external-submit',unitId:unit.unitId,expectedRevision:saved.revision,kind:'submit',answer:'External submitted answer',referenceSeen:false,submittedAt:'2026-10-26T09:01:00Z'});
 fail=false;await assert.rejects(f.session.retrySave(),/conflict/);await f.session.reloadSaved();
 assert.equal(f.session.snapshot().input,'Local unsubmitted text');assert.equal(f.session.snapshot().workspace.answer,'External submitted answer');
 assert.equal(button(f.view(),'继续').props.disabled,true);assert.match(JSON.stringify(f.view()),/本页未保存输入/);await assert.rejects(f.session.flush(),/unsaved-input-conflict/);
});
test('explicit conflict reread of unchanged saved answer unblocks flush without applying the failed metadata',async()=>{
 let fail=true;const f=await fixture((write,m)=>{if(fail&&m.kind==='reference')throw Error('quota');return write();});
 await assert.rejects(f.session.reveal(),/quota/);const saved=await f.base.read(scope,unit.unitId);
 await f.base.mutate(scope,{schemaVersion:1,operationId:'external-pause',unitId:unit.unitId,expectedRevision:saved.revision,kind:'pause',paused:true,activeSeconds:4});
 fail=false;await assert.rejects(f.session.retrySave(),/conflict/);await f.session.reloadSaved();await f.session.flush();
 assert.equal(f.session.snapshot().workspace.referenceSeen,false);assert.equal(f.session.snapshot().input,'Original answer');assert.equal(button(f.view(),'继续').props.disabled,false);
 assert.equal(f.session.snapshot().workspace.operations.filter(m=>m.kind==='reference').length,0);
});
test('failed submission recovery preserves the full original answer, timestamp and revision',async()=>{
 let fail=true;const f=await fixture((write,m)=>{if(fail&&m.kind==='submit'&&m.answer==='Retry original')throw Error('quota');return write();});
 await f.session.retry();await f.session.answer('Retry original');await assert.rejects(f.session.submit(),/quota/);
 const original=structuredClone(f.writes.at(-1));fail=false;await f.session.retrySave();
 assert.deepEqual(f.writes.at(-1),original);assert.equal(f.session.snapshot().workspace.attempts[1].submission.answer,'Retry original');
 assert.equal(f.session.snapshot().workspace.attempts[1].submission.submittedAt,original.submittedAt);await f.session.flush();
});
test('a late failed retry cannot replace a newer successful draft with its obsolete error',async()=>{
 const gate=deferred();let hold=false;const f=await fixture(async(write,m)=>{if(m.kind==='draft'&&m.answer==='A'){if(hold)await gate.promise;throw Error('quota');}return write();});
 await f.session.retry();await assert.rejects(f.session.answer('A'),/quota/);hold=true;
 const retry=f.session.retrySave(),rejected=assert.rejects(retry,/quota/);await tick();const edit=f.session.answer('AB');gate.resolve();await rejected;await edit;
 assert.equal(f.session.snapshot().workspace.answer,'AB');assert.equal(f.session.snapshot().input,'AB');assert.equal(f.session.snapshot().error,'');await f.session.flush();
});
test('a newer edit cancels a retry before it reaches the persistence boundary',async()=>{
 let fail=true;const f=await fixture((write,m)=>{if(fail&&m.kind==='draft'&&m.answer==='A')throw Error('quota');return write();});
 await f.session.retry();await assert.rejects(f.session.answer('A'),/quota/);fail=false;
 const before=f.writes.length,retry=f.session.retrySave(),edit=f.session.answer('AB');await retry;await edit;
 assert.equal(f.writes.length,before+1);assert.equal(f.writes.at(-1).answer,'AB');assert.equal(f.session.snapshot().workspace.answer,'AB');
});
test('a persistence prerequisite read failure retains the input and navigation protection until a safe reread',async()=>{
 const f=await fixture();await f.session.retry();let fail=true;
 const read=f.base.read;
 // A new session uses the same durable journal, with only its prerequisite read faulted.
 const session=createPaperReadingSession({unit,store:{...f.base,read:(...args)=>{if(fail)throw Error('paper-reading-load-unavailable');return read(...args);}},makeId:()=>crypto.randomUUID(),now:()=>new Date()});
 fail=false;await session.load();fail=true;await assert.rejects(session.answer('Unwritten input'),/load-unavailable/);
 assert.equal(session.snapshot().input,'Unwritten input');assert.match(session.snapshot().error,/load-unavailable/);await assert.rejects(session.flush());
 fail=false;await session.reloadSaved();assert.equal(session.snapshot().input,'Unwritten input');await session.answer('Reviewed input');await session.flush();
});
