import type {NativeMathCapture,NativeMathIdentity} from './native-source';
import type {MathMappingPreparationV1,MathVariant} from '../guided-math';
import type {PracticeVariantRecoveryV1} from '../practice-evidence';
// @ts-expect-error TS5097: standalone Node contracts.
import {parseNativeMathCapture,parseNativeMathIdentity} from './native-source.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {parseMathVariantMapping,createMappedMathVariant} from '../guided-math/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {studyObject,studyDigest,studyHash,studyCount,studySize,studyText} from '../sync/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {evidenceEqual,parsePracticeVariantRecovery,validatePracticeEvidenceTree} from '../practice-evidence/index.ts';

export type NativeMathMappingRecord={schemaVersion:1;identity:NativeMathIdentity;captureId:string;preparation:MathMappingPreparationV1;receiptHash:string};
export type NativePreparedMathVariant={variant:MathVariant;descriptor:PracticeVariantRecoveryV1};
const normalized=(values:string[])=>values.map(value=>value.trim().replace(/\s+/gu,' ').toLowerCase()).sort();
/** Authenticated read supplies approval; validation binds the exact native captured source. */
export async function validateNativeMathMappingRecord(raw:unknown,original:NativeMathCapture):Promise<NativeMathMappingRecord>{
    validatePracticeEvidenceTree(raw);studySize(raw,32000);const capture=await parseNativeMathCapture(original);
    const r=studyObject(raw,['schemaVersion','identity','captureId','preparation','receiptHash']);
    studyDigest(r.captureId);studyDigest(r.receiptHash);const identity=parseNativeMathIdentity(r.identity),p=studyObject(r.preparation,['schemaVersion','snapshotId','mapping','review']);
    const reviewRow=studyObject(p.review,['sourceQuote','rationale']);studyText(reviewRow.sourceQuote,'math-source-quote',1000);studyText(reviewRow.rationale,'math-review-rationale',2000);
    if(p.schemaVersion!==1)throw Error('native-math-mapping-version');
    const preparation:MathMappingPreparationV1={schemaVersion:1,snapshotId:p.snapshotId as string,mapping:parseMathVariantMapping(p.mapping),review:{sourceQuote:reviewRow.sourceQuote,rationale:reviewRow.rationale}};
    const m=preparation.mapping,s=capture.item.learningSupport,review=preparation.review;
    if(r.schemaVersion!==1||!evidenceEqual(identity,capture.identity)||r.captureId!==capture.captureId||preparation.snapshotId!=='local'
        ||!s||s.schemaVersion!==2||s.variantMappingId!==m.mappingId||m.parentItemKey!==identity.itemKey||m.parentContentHash!==identity.contentHash||m.hashKind!=='content')
        throw Error('native-math-mapping-source-binding');
    if(!s.conditions?.length||!m.sourceConditions.length||!evidenceEqual(normalized(s.conditions),normalized(m.sourceConditions)))throw Error('native-math-mapping-conditions-binding');
    if(!capture.item.practice.prompt.includes(review.sourceQuote)||review.rationale.trim().length<20||review.rationale.trim()===review.sourceQuote.trim())throw Error('native-math-mapping-review-binding');
    const {receiptHash,...body}=r;if(await studyHash(body)!==receiptHash)throw Error('native-math-mapping-integrity');
    return structuredClone(r) as NativeMathMappingRecord;
}
export async function rebuildNativeMathVariant(capture:NativeMathCapture,record:NativeMathMappingRecord,seed:number):Promise<NativePreparedMathVariant>{
    await validateNativeMathMappingRecord(record,capture);studyCount(seed,'math-seed');if(seed>0xffffffff)throw Error('native-math-variant-seed');
    const mapping=record.preparation.mapping,support=capture.item.learningSupport!;
    const rebuilt=await createMappedMathVariant({parent:{parentItemKey:capture.identity.itemKey,parentContentHash:capture.identity.contentHash,hashKind:'content'},support,mapping,seed});
    if(rebuilt.status!=='available')throw Error('native-math-variant-source-binding');const v=rebuilt.variant;
    return {variant:v,descriptor:{schemaVersion:1,mappingId:rebuilt.mappingId,...v.parent,templateVersion:1,templateId:v.templateId,seed:v.seed,parameters:v.parameters,variantHash:v.variantHash}};
}
export async function validateNativeMathVariant(raw:unknown,capture:NativeMathCapture,record:NativeMathMappingRecord,seed:number):Promise<NativePreparedMathVariant|null>{
    validatePracticeEvidenceTree(raw);studySize(raw,32000);
    if((raw as {status?:unknown})?.status==='unavailable'){
        const r=studyObject(raw,['schemaVersion','status','reason']);if(r.schemaVersion!==1||!['submitted-parent-unavailable','missing-approved-mapping'].includes(String(r.reason)))throw Error('native-math-variant-response-binding');return null;
    }
    const r=studyObject(raw,['schemaVersion','status','variant','descriptor','mapping']),rebuilt=await rebuildNativeMathVariant(capture,record,seed);
    if(r.schemaVersion!==1||r.status!=='available'||!evidenceEqual(r.mapping,record.preparation.mapping)||!evidenceEqual(r.variant,rebuilt.variant)
        ||!evidenceEqual(parsePracticeVariantRecovery(r.descriptor),rebuilt.descriptor))throw Error('native-math-variant-response-binding');
    return rebuilt;
}
