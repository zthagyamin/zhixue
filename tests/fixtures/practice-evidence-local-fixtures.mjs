import {createLocalPracticeEvidenceRepository} from '../../src/infrastructure/practice-evidence/index.ts';
import {attempt,mutation,source} from './practice-evidence-fixtures.mjs';
let count=0;
export const fixture=(mode='code',submitted=true)=>{
 const ownerId=`evidence-owner-${count++}`,scope={ownerId,libraryId:'library'},a=attempt(mode,submitted);a.binding.ownerId=ownerId;
 const attempts={readAttempt:async id=>id===a.attemptId?structuredClone(a):null,resolveSource:async()=>({...source(),binding:a.binding})};
 const m=(kind,extra={},revision=0,id='op')=>({...mutation(kind,extra,revision,id),binding:a.binding});
 return {scope,a,attempts,m,repo:createLocalPracticeEvidenceRepository(scope,attempts)};
};
