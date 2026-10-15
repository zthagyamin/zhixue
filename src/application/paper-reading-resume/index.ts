import type {PaperReadingWorkspaceV1} from '../../domain/paper-reading';
// @ts-expect-error TS5097: standalone Node contracts.
import {parsePaperReadingWorkspace} from '../../domain/paper-reading/index.ts';
export type PaperReadingResumeSource={materialFingerprint:string;sourceVersion:string;sections:{id:string;paragraphs:{id:string;rawEn:string;pageNumber?:number}[]}[]};
/** Match an existing original version, never reconstruct a paper from question snippets. */
export function matchPaperReadingResume(raw:PaperReadingWorkspaceV1,material:PaperReadingResumeSource):{position:number;count:number}|null{
    const workspace=parsePaperReadingWorkspace(raw),source=workspace.unit.source;
    if(material.materialFingerprint!==source.materialFingerprint||material.sourceVersion!==source.sourceVersion)return null;
    let position=0;
    for(const section of material.sections){
        if(section.id===source.sectionId){
            const start=section.paragraphs.findIndex(paragraph=>paragraph.id===source.paragraphs[0].id);
            if(start<0)return null;
            const chosen=section.paragraphs.slice(start,start+source.paragraphs.length);
            if(chosen.length!==source.paragraphs.length||chosen.some((paragraph,index)=>{
                const expected=source.paragraphs[index];return paragraph.id!==expected.id||paragraph.rawEn!==expected.rawEn||paragraph.pageNumber!==expected.pageNumber;
            }))return null;
            return {position:position+start,count:chosen.length};
        }
        position+=section.paragraphs.length;
    }
    return null;
}
