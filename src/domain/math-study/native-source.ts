import type {AttemptBinding} from '../learning-attempt';
import type {CalculationSupport} from '../content';
// @ts-expect-error TS5097: standalone Node contracts.
import {studyObject,studyId,studyDigest,studyText,studySize,studyHash} from '../sync/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {parseCalculationSupport} from '../content/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {validatePracticeEvidenceTree} from '../practice-evidence/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {numericEquivalent} from '../math/index.ts';

export type NativeMathIdentity={schemaVersion:1;libraryId:string;itemKey:string;contentHash:string;localBindingHash:string};
export type NativeMathItem={schemaVersion:2;kind:'practice';eventKind:'due';itemKey:string;contentHash:string;learningSupport?:CalculationSupport;
    practice:{questionType:'calculation';prompt:string;answer:string;sourceLabel:string;domain:string;explanation?:string}};
export type NativeMathCapture={schemaVersion:1;captureId:string;identity:NativeMathIdentity;item:NativeMathItem};
export function parseNativeMathIdentity(raw:unknown):NativeMathIdentity{
    const r=studyObject(raw,['schemaVersion','libraryId','itemKey','contentHash','localBindingHash']);
    if(r.schemaVersion!==1||typeof r.libraryId!=='string'||!/^local-vault:[a-f0-9]{64}$/.test(r.libraryId))throw Error('native-math-identity');
    studyId(r.itemKey);studyDigest(r.contentHash);studyDigest(r.localBindingHash);
    if(!r.itemKey.startsWith('practice:'))throw Error('native-math-identity');
    return structuredClone(r) as NativeMathIdentity;
}
export function parseNativeMathItem(raw:unknown,identity:NativeMathIdentity):NativeMathItem{
    validatePracticeEvidenceTree(raw);studySize(raw,32000);
    const item=studyObject(raw,['schemaVersion','kind','eventKind','itemKey','contentHash','practice'],['learningSupport']);
    const p=studyObject(item.practice,['questionType','prompt','answer','sourceLabel','domain'],['explanation']);
    if(item.schemaVersion!==2||item.kind!=='practice'||item.eventKind!=='due'||p.questionType!=='calculation'
        ||item.itemKey!==identity.itemKey||item.contentHash!==identity.contentHash)throw Error('native-math-source-binding');
    studyText(p.prompt,'math-question',4000);studyText(p.answer,'math-reference',512);
    studyText(p.sourceLabel,'math-source-label',200);studyText(p.domain,'math-domain',100);
    if(p.explanation!==undefined)studyText(p.explanation,'math-explanation',4000);
    if(item.learningSupport!==undefined)parseCalculationSupport(item.learningSupport);
    return structuredClone(item) as NativeMathItem;
}
/** Exact native public body hash; contentHash remains the indexed native signature. */
export async function parseNativeMathCapture(raw:unknown):Promise<NativeMathCapture>{
    validatePracticeEvidenceTree(raw);studySize(raw,64000);
    const r=studyObject(raw,['schemaVersion','captureId','identity','item']);
    if(r.schemaVersion!==1)throw Error('native-math-capture-version');studyDigest(r.captureId);
    const identity=parseNativeMathIdentity(r.identity),item=parseNativeMathItem(r.item,identity);
    const body={schemaVersion:1 as const,identity,item};
    if(await studyHash(body)!==r.captureId)throw Error('native-math-capture-integrity');
    return {...body,captureId:r.captureId};
}
export function assertNativeMathCaptureBinding(capture:NativeMathCapture,binding:AttemptBinding):void{
    const i=capture.identity;
    if(binding.snapshotId!=='local'||binding.libraryId!==i.libraryId||binding.itemKey!==i.itemKey||binding.contentHash!==i.contentHash)
        throw Error('native-math-attempt-source-binding');
}
/** Missing authored support permits only a safe decimal kernel, never symbolic guessing. */
export function resolveNativeMathSupport(item:NativeMathItem):CalculationSupport|null{
    if(item.learningSupport)return parseCalculationSupport(item.learningSupport);
    if(numericEquivalent(item.practice.answer,item.practice.answer,'0')===null)return null;
    return {schemaVersion:1,type:'calculation',mode:'numeric',variables:[],domain:'real',tolerance:'0.000001'};
}
