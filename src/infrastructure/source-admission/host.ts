import type {NonWordHostScope,NonWordMode} from '../../application/nonword-study';
import type {SourceAdmissionQuery,SourceAdmissionJson} from '../../domain/source-admission';
// @ts-expect-error TS5097: standalone Node contracts.
import {sourceAdmissionJson} from '../../domain/source-admission/index.ts';

const fields=['questionType','prompt','front','back','options','answer','explanation','initialCode','testCode',
    'referenceCode','solutionCode','language','learningSupport','codeMaterial','variables','tolerance','reviewPoint'] as const;
/** Extract original question material; display choices and routing fields are excluded. */
export function sourceQuestionQuery(scope:NonWordHostScope,mode:NonWordMode,raw:unknown):SourceAdmissionQuery{
    if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('source-admission-presentation');
    const original=raw as Record<string,unknown>;
    const material=original.practiceItem&&typeof original.practiceItem==='object'&&!Array.isArray(original.practiceItem)
        ?original.practiceItem as Record<string,unknown>:original;
    const presentation:Record<string,SourceAdmissionJson>={};
    for(const field of fields){const value=material[field];
        if(value!==undefined&&value!==null&&value!==''&&(!Array.isArray(value)||value.length))presentation[field]=sourceAdmissionJson(value);}
    if(!presentation.questionType)presentation.questionType=String(original.pluginType??original.type??original.kind??mode);
    if(!presentation.learningSupport&&original.learningSupport)presentation.learningSupport=sourceAdmissionJson(original.learningSupport);
    return {itemKey:scope.itemKey,contentHash:scope.contentHash,presentation};
}
