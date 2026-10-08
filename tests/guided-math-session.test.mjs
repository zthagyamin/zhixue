import assert from 'node:assert/strict';
import test from 'node:test';
import {createTemporaryDraft} from '../src/application/temporary-practice/index.ts';
import {createGuidedMathSession,mathDraftFields} from '../src/application/guided-math/index.ts';
import {createMathVariant} from '../src/domain/guided-math/index.ts';
const parent={parentItemKey:'a',parentContentHash:'v1',hashKind:'content'};
const deferred=()=>{let resolve;const promise=new Promise(done=>resolve=done);return {resolve,promise};};

test('preparation is explicit, deduplicated, and cancelled results cannot replace the session',async()=>{
 const draft=createTemporaryDraft({initial:mathDraftFields}),wait=deferred();let calls=0;
 const session=createGuidedMathSession(draft,parent,async()=>{calls++;return wait.promise;});
 await session.prepare();assert.equal(calls,0);assert.equal(session.snapshot().variant,null);
 session.edit('approved','yes');const pending=session.prepare();await session.prepare();assert.equal(calls,1);
 session.cancel();wait.resolve(await createMathVariant({parent,templateId:'sqrt-sign',seed:1}));await pending;
 assert.equal(session.snapshot().variant,null);assert.equal(draft.isBusy(),false);session.dispose();
});
test('steps and reference stay assisted through edits, final and process verdicts stay separate',async()=>{
 const draft=createTemporaryDraft({initial:mathDraftFields});
 const session=createGuidedMathSession(draft,parent,async()=>createMathVariant({parent,templateId:'sqrt-sign',seed:1,parameters:{x:-2}}));
 session.edit('approved','yes');await session.prepare();
 session.edit('answerKind','number');session.edit('answer','2');session.check();
 assert.equal(session.snapshot().result.final.verdict,'correct');assert.equal(session.snapshot().result.steps,null);
 session.showSteps();session.edit('method','principal-root');session.edit('condition','negative');session.edit('transformation','x');session.check();
 assert.equal(session.snapshot().result.final.verdict,'correct');assert.equal(session.snapshot().result.steps.verdict,'wrong');
 assert.equal(session.snapshot().assisted,true);session.edit('transformation','-x');assert.equal(session.snapshot().result,null);
 session.check();assert.equal(session.snapshot().result.steps.verdict,'correct');assert.equal(session.snapshot().assisted,true);
 assert.equal('onGrade' in session,false);assert.equal('save' in session,false);
 assert.equal(session.restart(false),false);session.acknowledge();assert.equal(session.restart(false),true);
 assert.equal(session.snapshot().variant,null);assert.equal(session.snapshot().assisted,false);
});
test('changing the parent while preparing invalidates late generation without altering other input',async()=>{
 let active=true;const draft=createTemporaryDraft({initial:mathDraftFields,isCurrent:()=>active}),wait=deferred();
 const session=createGuidedMathSession(draft,parent,()=>wait.promise);session.edit('approved','yes');
 const pending=session.prepare();active=false;wait.resolve(await createMathVariant({parent,templateId:'sqrt-sign',seed:1}));await pending;
 assert.equal(session.snapshot().variant,null);assert.equal(session.edit('answer','late'),false);session.dispose();
});
test('reopening the same problem does not erase exposure to reference or feedback',async()=>{
 const draft=createTemporaryDraft({initial:mathDraftFields});
 const session=createGuidedMathSession(draft,parent,async input=>createMathVariant({...input,templateId:'sqrt-sign',parameters:{x:-2}}));
 session.edit('approved','yes');await session.prepare();const first=session.snapshot().variant;
 session.showReference();assert.equal(session.restart(true),true);
 session.edit('seed','99');session.edit('approved','yes');await session.prepare();
 assert.notEqual(session.snapshot().variant.variantHash,first.variantHash);
 assert.equal(session.snapshot().assisted,true,'the same mathematical instance remains seen even under another seed');
});
