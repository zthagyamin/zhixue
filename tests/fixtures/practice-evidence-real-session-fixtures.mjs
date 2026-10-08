import {createNonWordSession} from '../../src/application/nonword-study/index.ts';
import {createLocalAttemptRepository} from '../../src/infrastructure/learning-attempt/index.ts';
import {createLocalPracticeEvidenceRepository} from '../../src/infrastructure/practice-evidence/index.ts';
import {binding,source,mutation} from './practice-evidence-fixtures.mjs';
let sequence=0;
export const realSessionFixture=(mode='code')=>{
 const ownerId=`real-evidence-owner-${sequence++}`,scope={ownerId,libraryId:'library'},b={...binding,ownerId},originals=createLocalAttemptRepository({userId:ownerId,libraryId:'library'});
 let operations=0;
 const makeSession=(id='attempt',parentAttemptId)=>createNonWordSession({repository:originals,binding:b,attemptId:id,formalEventId:`formal-${id}`,mode,purpose:parentAttemptId?'remediation':'first',...(parentAttemptId?{parentAttemptId}:{}),now:()=> '2026-10-08T00:00:00Z',newId:()=>`operation-${operations++}`,fingerprint:async value=>JSON.stringify(value),evaluationFingerprint:async()=> 'c'.repeat(64)});
 const attempts={readAttempt:id=>originals.read(id),resolveSource:async()=>({...source(),binding:b})};
 const m=(kind,extra={},revision=0,id='sidecar')=>({...mutation(kind,extra,revision,id),binding:b});
 return {scope,binding:b,originals,makeSession,session:makeSession(),attempts,m,repo:createLocalPracticeEvidenceRepository(scope,attempts)};
};
