import type {StudyItemVersion,StudySnapshot} from '../../domain/sync';
import type {MathMappingPreparationRecordV1,MathVariant} from '../../domain/guided-math';
import type {PracticeVariantRecoveryV1} from '../../domain/practice-evidence';
// @ts-expect-error TS5097: standalone Node contracts.
import {studyObject,studyHash,studyId,studyIso} from '../../domain/sync/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {validateMathMappingPreparation,createMappedMathVariant} from '../../domain/guided-math/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {resolveCalculationReferenceSupport} from '../../domain/math-study/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {evidenceEqual,parsePracticeVariantRecovery} from '../../domain/practice-evidence/index.ts';
export type AccountMathOriginal={item:StudyItemVersion;snapshot:StudySnapshot};
export type PreparedMathVariant={variant:MathVariant;descriptor:PracticeVariantRecoveryV1};
export async function validateAccountMathOriginal(original:AccountMathOriginal,scope:{libraryId:string}){
    const {contentHash,...item}=original.item,{snapshotHash,...snapshot}=original.snapshot;
    if(await studyHash(item)!==contentHash||await studyHash(snapshot)!==snapshotHash)throw Error('math-original-source-integrity');
    if(item.kind!=='practice'||item.practice.questionType!=='calculation'||snapshot.libraryId!==scope.libraryId
        ||!snapshot.items.some(member=>member.itemKey===item.itemKey&&member.contentHash===contentHash))throw Error('math-original-source-binding');
    return resolveCalculationReferenceSupport(item.learningSupport,item.practice.answer)??undefined;
}
export async function validateApprovedMathRecord(raw:unknown,original:AccountMathOriginal,scope:{libraryId:string}):Promise<MathMappingPreparationRecordV1>{
    await validateAccountMathOriginal(original,scope);
    const record=studyObject(raw,['schemaVersion','preparation','provenance','technicalValidation']);
    if(record.schemaVersion!==1)throw Error('math-mapping-record-version');
    const preparation=validateMathMappingPreparation(record.preparation,original.item);
    if(preparation.snapshotId!==original.snapshot.snapshotId)throw Error('math-mapping-snapshot-binding');
    const provenance=studyObject(record.provenance,['originGrantId','publishedAt']);studyId(provenance.originGrantId);studyIso(provenance.publishedAt);
    const technical=studyObject(record.technicalValidation,['schemaVersion','templateVersion']);
    if(technical.schemaVersion!==1||technical.templateVersion!==1)throw Error('math-mapping-record-version');
    return {schemaVersion:1,preparation,provenance:{originGrantId:provenance.originGrantId,publishedAt:provenance.publishedAt},technicalValidation:{schemaVersion:1,templateVersion:1}};
}
export async function rebuildApprovedMathVariant(original:AccountMathOriginal,record:MathMappingPreparationRecordV1,seed:number):Promise<PreparedMathVariant>{
    const support=await validateAccountMathOriginal(original,{libraryId:original.snapshot.libraryId});
    await validateApprovedMathRecord(record,original,{libraryId:original.snapshot.libraryId});
    if(!support)throw Error('math-variant-source-binding');
    const mapping=record.preparation.mapping;
    const result=await createMappedMathVariant({parent:{parentItemKey:original.item.itemKey,parentContentHash:original.item.contentHash,hashKind:'content'},support,mapping,seed});
    if(result.status!=='available')throw Error('math-variant-source-binding');
    const v=result.variant;
    return {variant:v,descriptor:{schemaVersion:1,mappingId:result.mappingId,...v.parent,templateVersion:1,templateId:v.templateId,seed:v.seed,parameters:v.parameters,variantHash:v.variantHash}};
}
/** Authenticated references only. No publishing or learner-selected map exists here. */
export function createAccountMathMappingClient(scope:{ownerId:string;libraryId:string},original:AccountMathOriginal,fetcher:typeof fetch=fetch){
    const request=async(action:string,attemptId:string,seed?:number,signal?:AbortSignal)=>{
        studyId(attemptId);signal?.throwIfAborted();
        const response=await fetcher('/api/account-study',{method:'POST',credentials:'same-origin',signal:AbortSignal.any([...(signal?[signal]:[]),AbortSignal.timeout(20000)]),
            headers:{'Content-Type':'application/json'},body:JSON.stringify({action,expectedUserId:scope.ownerId,libraryId:scope.libraryId,attemptId,...(seed===undefined?{}:{seed})})});
        const raw=await response.json();signal?.throwIfAborted();
        if(!response.ok)throw Error('math-mapping-service-unavailable');
        return raw as Record<string,unknown>;
    };
    return {
        async read(attemptId:string,signal?:AbortSignal){
            const raw=await request('math-mapping-read',attemptId,undefined,signal);
            if(raw?.status==='unavailable'){studyObject(raw,['status']);return null;}
            const value=studyObject(raw,['status','schemaVersion','preparation','provenance','technicalValidation']);
            if(value.status!=='available')throw Error('math-mapping-service-binding');
            const {status:_,...record}=value;void _;return validateApprovedMathRecord(record,original,scope);
        },
        async variant(attemptId:string,seed:number,approved:MathMappingPreparationRecordV1,signal?:AbortSignal):Promise<PreparedMathVariant|null>{
            const rebuilt=await rebuildApprovedMathVariant(original,approved,seed),raw=await request('math-variant',attemptId,seed,signal);
            if(raw?.status==='unavailable'){studyObject(raw,['status']);return null;}
            const value=studyObject(raw,['status','variant','descriptor','mapping']);
            if(value.status!=='available'||!evidenceEqual(value.mapping,approved.preparation.mapping)||!evidenceEqual(value.variant,rebuilt.variant)
                ||!evidenceEqual(parsePracticeVariantRecovery(value.descriptor),rebuilt.descriptor))throw Error('math-variant-service-binding');
            return rebuilt;
        }
    };
}
