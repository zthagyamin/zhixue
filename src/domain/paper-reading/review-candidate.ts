import type {CandidateArtifact,CandidateSource,CandidateRow} from '../practice-candidates';
import type {PaperReadingUnitV1} from './workspace';
import type {PaperReadingTaskV1} from './evidence';
// @ts-expect-error TS5097: standalone Node contracts.
import {paperReadingTask} from './evidence.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {canonicalAttemptJson} from '../learning-attempt/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {studyHash} from '../sync/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {approveCandidates} from '../practice-candidates/index.ts';
export type PaperReviewContext={
    schemaVersion:1;paperId:string;sourceNote:string|null;materialFingerprint:string;sourceVersion:string;
    unitId:string;taskId:string;taskRevision:number;abilityType:PaperReadingTaskV1['ability'];abilityId:string;mappingStatus:'candidate';
    sectionId:string;paragraphs:{id:string;rawEn:string;pageNumber?:number}[];
};
export type PaperReviewPreparation={source:CandidateSource;seeds:CandidateRow[];context:Omit<PaperReviewContext,'abilityId'>};
export type ReadingCandidateArtifact=Omit<CandidateArtifact,'schemaVersion'>&{schemaVersion:2;readingContext:PaperReviewContext};
export function preparePaperReviewCandidate(unit:PaperReadingUnitV1,task:PaperReadingTaskV1,meta:{paperId:string;sourceNote?:string;sectionLabel?:string}):PaperReviewPreparation{
    if(task.status!=='ready'||paperReadingTask(task).status!=='ready')throw Error('paper-candidate-task-not-ready');
    if(canonicalAttemptJson(unit.source)!==canonicalAttemptJson(task.source)||unit.goal!==task.goal)throw Error('paper-candidate-source-binding');
    if(!meta.paperId||meta.paperId.length>200||meta.sourceNote&&meta.sourceNote.length>1000)throw Error('paper-candidate-metadata');
    const first=task.reference[0],paragraphIndex=unit.source.paragraphs.findIndex(p=>p.id===first.paragraphId);
    const source:CandidateSource={kind:'paper',key:meta.sourceNote&&meta.sourceNote.length<=500?meta.sourceNote:'paper-reading:'+unit.unitId,
        version:unit.source.sourceVersion,versionKind:'paper-origin',title:unit.title,
        fragments:unit.source.paragraphs.map((p,i)=>({id:'reading-p-'+(i+1),label:(meta.sectionLabel??unit.source.sectionId)+(p.pageNumber?' · PDF 第 '+p.pageNumber+' 页':''),text:p.rawEn,...(p.pageNumber?{page:p.pageNumber}:{})}))};
    return {source,seeds:[{id:'reading-question',question:task.question,reference:task.reference.map(r=>r.point).join('\n'),keyPoints:task.reference.map(r=>r.point).join('\n'),
        category:'',fragmentId:'reading-p-'+(paragraphIndex+1),quote:first.quote}],context:{schemaVersion:1,paperId:meta.paperId,sourceNote:meta.sourceNote??null,
        materialFingerprint:unit.source.materialFingerprint,sourceVersion:unit.source.sourceVersion,unitId:unit.unitId,taskId:task.taskId,taskRevision:task.revision,
        abilityType:task.ability,mappingStatus:'candidate',sectionId:unit.source.sectionId,paragraphs:structuredClone(unit.source.paragraphs)}};
}
/** Content identity changes with edits; only the existing explicit review can prepare an import artifact. */
export async function readingCandidateArtifact(approved:CandidateArtifact,preparation:PaperReviewPreparation):Promise<ReadingCandidateArtifact>{
    if(approved.documentType!=='zhixue-practice-candidates'||approved.schemaVersion!==1||approved.status!=='reviewed-candidates'
        ||approved.parent.key!==preparation.source.key||approved.parent.sourceVersion!==preparation.source.version||approved.parent.kind!=='paper'
        ||approved.parent.title!==preparation.source.title||approved.parent.versionKind!==preparation.source.versionKind)throw Error('paper-candidate-source-binding');
    const validated=approveCandidates(preparation.source,approved.items,{reviewed:true,workload:true,currentVersion:preparation.source.version});
    if(canonicalAttemptJson(validated)!==canonicalAttemptJson(approved))throw Error('paper-candidate-citation-binding');
    const context={...structuredClone(preparation.context),abilityId:'paper-ability:'+await studyHash({source:preparation.context.materialFingerprint,taskId:preparation.context.taskId,
        taskRevision:preparation.context.taskRevision,abilityType:preparation.context.abilityType})};
    const items=await Promise.all(validated.items.map(async row=>({...row,id:'paper-candidate:'+await studyHash({parent:validated.parent,readingContext:context,row:{...row,id:undefined}})})));
    return {...validated,schemaVersion:2,readingContext:context,items};
}
