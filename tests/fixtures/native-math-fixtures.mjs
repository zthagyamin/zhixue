import {createNativeMathSourceCache} from '../../src/infrastructure/math-study/native-source-cache.ts';
import {studyHash} from '../../src/domain/sync/index.ts';
let sequence=0;
export async function fixture(){
 const ownerId='math-cache-owner-'+sequence++,libraryId='local-vault:'+'a'.repeat(64);
 const identity={schemaVersion:1,libraryId,itemKey:'practice:calculation',contentHash:'b'.repeat(64),localBindingHash:'c'.repeat(64)};
 const support={schemaVersion:2,type:'calculation',mode:'numeric',variables:[],domain:'real',step:{stepId:'intermediate',prompt:'Give intermediate value',reference:'2',mode:'numeric'}};
 const item={schemaVersion:2,kind:'practice',eventKind:'due',itemKey:identity.itemKey,contentHash:identity.contentHash,learningSupport:support,practice:{questionType:'calculation',prompt:'Calculate 2+2',answer:'4',sourceLabel:'Original lesson',domain:'math'}};
 const body={schemaVersion:1,identity,item},capture={...body,captureId:await studyHash(body)};
 const binding={ownerId,libraryId,snapshotId:'local',itemKey:identity.itemKey,contentHash:identity.contentHash,groupId:'group',roundId:'round'};
 const attempt={schemaVersion:1,attemptId:'original',binding,parentAttemptId:null,revision:2,answerRevision:1,answer:'4',updatedAt:'2026-10-08T00:00:00.000Z',checkpoint:{mode:'calculation',purpose:'first',phase:'submitted',position:0,traversed:false},submitted:{answer:'4',answerRevision:1,submittedAt:'2026-10-08T00:00:00.000Z',assistance:'unknown'},evaluation:{status:'pending',reason:'not-requested'},formal:null,operations:[]};
 const claim={schemaVersion:1,identity,captureId:capture.captureId,attempt,stepInput:{text:'2',revision:1,answerRevision:1}};
 const scope={userId:ownerId,libraryId},cache=createNativeMathSourceCache(scope);
 return {scope,identity,support,item,capture,binding,attempt,claim,cache};
}
