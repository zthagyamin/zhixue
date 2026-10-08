import test from 'node:test';
import assert from 'node:assert/strict';
import {createPracticeEvidenceSession,createTrustedPracticeEvidenceWriter} from '../src/application/practice-evidence/index.ts';
import {attempt,mutation,source,diagnostic} from './fixtures/practice-evidence-fixtures.mjs';
test('serial session validates full scope/source and forbids caller model trust',async()=>{
 const a=attempt('calculation'),events=[],attempts={readAttempt:async()=>a,resolveSource:async()=>source()},store={read:async()=>null,mutate:async m=>{events.push(m.operationId);await Promise.resolve();return {status:'accepted',revision:1,durable:true,record:null};}};
 const options={scope:{ownerId:'owner',libraryId:'library'},attempts,store},s=createPracticeEvidenceSession(options);
 await s.open('attempt');await Promise.all([s.mutate(mutation('step-input',{text:'2'},0,'one')),s.mutate(mutation('step-input',{text:'2'},1,'two'))]);assert.deepEqual(events,['one','two']);
 await assert.rejects(s.mutate(mutation('step-diagnostic',{diagnostic:diagnostic('correct','model')})),/trusted/);
 const trusted=createTrustedPracticeEvidenceWriter({...options,service:{resolveModelDiagnostic:async({diagnostic})=>diagnostic}});
 assert.equal((await trusted.mutate(mutation('step-diagnostic',{diagnostic:diagnostic('correct','model')}))).status,'accepted');
 await assert.rejects(createPracticeEvidenceSession({...options,scope:{ownerId:'other',libraryId:'library'}}).open('attempt'),/scope/);
 attempts.resolveSource=async()=>null;await assert.rejects(s.mutate(mutation('step-input',{text:'3'})),/source/);
});
