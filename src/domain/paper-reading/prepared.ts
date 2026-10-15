import type {PaperReadingUnitV1} from './workspace';
import type {PaperReadingTaskV1,PaperReadingReference} from './evidence';
// @ts-expect-error TS5097: standalone Node contracts.
import {paperReadingUnit} from './workspace.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {paperReadingTask} from './evidence.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {canonicalAttemptJson} from '../learning-attempt/index.ts';

/** Portable content only. Account, library, source text and goal come from the registered unit. */
export type PreparedPaperTaskPacketV1={
    schemaVersion:1;
    documentType:'paper-reading-prepared-question';
    materialFingerprint:string;
    sourceVersion:string;
    sectionId:string;
    paragraphIds:string[];
    question:string;
    ability:PaperReadingTaskV1['ability'];
    reference:PaperReadingReference[];
};
export type PreparedPaperTask={recipeHash:string;task:PaperReadingTaskV1};

function closed(value:unknown,fields:string[]):Record<string,unknown>{
    if(!value||typeof value!=='object'||Array.isArray(value)
        ||Object.keys(value).some(key=>!fields.includes(key))||fields.some(key=>!Object.hasOwn(value,key)))throw Error('paper-prepared-fields');
    return value as Record<string,unknown>;
}
export function parsePreparedPaperTaskPacket(base:PaperReadingUnitV1,raw:unknown):PreparedPaperTaskPacketV1{
    const unit=paperReadingUnit(base);
    const value=closed(raw,['schemaVersion','documentType','materialFingerprint','sourceVersion','sectionId','paragraphIds','question','ability','reference']);
    if(value.schemaVersion!==1||value.documentType!=='paper-reading-prepared-question')throw Error('paper-prepared-schema');
    const source=unit.source;
    if(value.materialFingerprint!==source.materialFingerprint||value.sourceVersion!==source.sourceVersion
        ||value.sectionId!==source.sectionId||canonicalAttemptJson(value.paragraphIds)!==canonicalAttemptJson(source.paragraphs.map(p=>p.id)))throw Error('paper-prepared-source');
    if(typeof value.question!=='string'||!Array.isArray(value.reference)
        ||!['definition','mechanism','comparison','condition','application'].includes(value.ability as string))throw Error('paper-prepared-content');
    for(const reference of value.reference)closed(reference,['point','paragraphId','quote']);
    const packet=structuredClone(value) as PreparedPaperTaskPacketV1;
    const checked=paperReadingTask({taskId:'prepared:validation',revision:1,source,origin:'prepared',goal:unit.goal,
        question:packet.question,ability:packet.ability,reference:packet.reference});
    if(checked.status!=='ready')throw Error('paper-prepared-'+checked.reason);
    return packet;
}
export function preparedPaperTaskRecipe(base:PaperReadingUnitV1,raw:unknown):string{
    const unit=paperReadingUnit(base),packet=parsePreparedPaperTaskPacket(unit,raw);
    return canonicalAttemptJson({recipeVersion:1,source:unit.source,goal:unit.goal,packet});
}
export function preparedPaperTask(base:PaperReadingUnitV1,raw:unknown,recipeHash:string):PreparedPaperTask{
    if(typeof recipeHash!=='string'||!/^[a-f0-9]{64}$/.test(recipeHash))throw Error('paper-prepared-hash');
    const unit=paperReadingUnit(base),packet=parsePreparedPaperTaskPacket(unit,raw);
    return {recipeHash,task:paperReadingTask({taskId:'prepared:'+recipeHash,revision:1,source:unit.source,origin:'prepared',
        goal:unit.goal,question:packet.question,ability:packet.ability,reference:packet.reference})};
}
/** Deliberately incomplete until the author supplies a specific question and exact source quotes. */
export function preparedPaperTaskTemplate(base:PaperReadingUnitV1):PreparedPaperTaskPacketV1{
    const unit=paperReadingUnit(base),source=unit.source;
    return {schemaVersion:1,documentType:'paper-reading-prepared-question',materialFingerprint:source.materialFingerprint,
        sourceVersion:source.sourceVersion,sectionId:source.sectionId,paragraphIds:source.paragraphs.map(p=>p.id),
        question:'',ability:'mechanism',reference:[{point:'',paragraphId:source.paragraphs[0].id,quote:''}]};
}
