// @ts-expect-error TS5097: standalone Node contracts.
import {loadWorkspaceRecord,updateWorkspaceRecord} from '../local-study-db.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {createPaperReadingUnit} from '../../src/domain/paper-reading/index.ts';
import type {PaperStudyData} from '../paper-study';

export type PaperReadingBookmarkScope={ownerId:string;libraryId:string};
export type PaperReadingBookmark={materialFingerprint:string;sourceVersion:string;position:number;count:number;activeUnitId?:string};
export type PaperReadingBookmarks={schemaVersion:1;ownerId:string;libraryId:string;lastMaterialFingerprint:string;entries:PaperReadingBookmark[]};
const digest=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
function kind(libraryId:string):`paper-reading-bookmark:v1:${string}`{return `paper-reading-bookmark:v1:${libraryId}`;}
function validEntry(raw:unknown):raw is PaperReadingBookmark{
    if(!raw||typeof raw!=='object'||Array.isArray(raw))return false;
    const value=raw as PaperReadingBookmark;
    return Object.keys(value).every(key=>['materialFingerprint','sourceVersion','position','count','activeUnitId'].includes(key))
        &&digest(value.materialFingerprint)&&digest(value.sourceVersion)&&Number.isSafeInteger(value.position)&&value.position>=0
        &&Number.isSafeInteger(value.count)&&value.count>=1&&value.count<=2667
        &&(value.activeUnitId===undefined||typeof value.activeUnitId==='string'&&Boolean(value.activeUnitId.trim())&&value.activeUnitId.length<=200);
}
function parse(raw:unknown,scope:PaperReadingBookmarkScope):PaperReadingBookmarks|null{
    if(!raw||typeof raw!=='object'||Array.isArray(raw))return null;
    const value=raw as PaperReadingBookmarks;
    if(value.schemaVersion!==1||value.ownerId!==scope.ownerId||value.libraryId!==scope.libraryId||!digest(value.lastMaterialFingerprint)
        ||!Array.isArray(value.entries)||value.entries.length>30||!value.entries.every(validEntry)
        ||new Set(value.entries.map(entry=>entry.materialFingerprint)).size!==value.entries.length
        ||!value.entries.some(entry=>entry.materialFingerprint===value.lastMaterialFingerprint))return null;
    return structuredClone(value);
}
export async function loadPaperReadingBookmarks(scope:PaperReadingBookmarkScope){
    return parse(await loadWorkspaceRecord<unknown>(scope.ownerId,kind(scope.libraryId),null),scope);
}
/** Optional device-only navigation metadata; never updates a draft, answer or event. */
export async function savePaperReadingBookmark(scope:PaperReadingBookmarkScope,entry:PaperReadingBookmark,isCurrent:()=>boolean=()=>true){
    const bound=structuredClone(scope),next=structuredClone(entry);
    if(!validEntry(next))throw Error('阅读位置无效，原文与草稿保留。');
    if(!isCurrent())throw Error('论文选择已变化，原草稿保留。');
    await updateWorkspaceRecord<unknown>(bound.ownerId,kind(bound.libraryId),null,raw=>{
        if(!isCurrent())throw Error('论文选择已变化，原草稿保留。');
        const previous=parse(raw,bound);
        return {schemaVersion:1,...bound,lastMaterialFingerprint:next.materialFingerprint,
            entries:[next,...(previous?.entries??[]).filter(value=>value.materialFingerprint!==next.materialFingerprint)].slice(0,30)} satisfies PaperReadingBookmarks;
    });
}
export function paperReadingBookmarkFor(bookmarks:PaperReadingBookmarks|null,paper:PaperStudyData,fingerprint:string):PaperReadingBookmark|null{
    const entry=bookmarks?.entries.find(value=>value.materialFingerprint===fingerprint);
    if(!entry||entry.sourceVersion!==(paper.origin?.version??fingerprint))return null;
    const total=paper.sections.reduce((sum,section)=>sum+section.paragraphs.length,0);
    if(entry.position>=total)return null;
    const unit=createPaperReadingUnit(paper,entry.position,entry.count);
    if(unit.position!==entry.position||unit.paragraphs.length!==entry.count)return null;
    return structuredClone(entry);
}
