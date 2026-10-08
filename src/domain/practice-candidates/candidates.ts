export type CandidateSource = {
    kind:'card'|'paper';key:string;version:string;versionKind:'item-content'|'paper-origin'|'visible-snapshot';title:string;
    fragments:readonly {id:string;label:string;text:string;page?:number}[];
};
export type CandidateRow = {id:string;question:string;reference:string;keyPoints:string;category:string;fragmentId:string;quote:string};
export type CandidateArtifact = {
    documentType:'zhixue-practice-candidates';schemaVersion:1;status:'reviewed-candidates';parent:{key:string;sourceVersion:string;versionKind:CandidateSource['versionKind'];kind:CandidateSource['kind'];title:string};
    items:Array<CandidateRow&{citation:{fragmentId:string;label:string;start:number;end:number;page?:number}}>;
};
const nonempty=(value:string,max:number)=>typeof value==='string'&&value.trim().length>0&&value.length<=max;
export async function sourceFingerprint(value:unknown):Promise<string>{
    const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(value)));
    return Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
}
/** Paragraph boundaries only; never invent atomic factual claims or activate cards. */
export function splitCardSections(front:string,back:string):CandidateRow[]{
    const sections=back.split(/\n\s*\n/).map(text=>text.trim()).filter(Boolean);
    if(sections.length<2||sections.length>6)return [];
    return sections.map((reference,index)=>({id:`part-${index+1}`,question:`${front}\n子点 ${index+1}（请核对题干是否明确）`,reference,keyPoints:'',category:'recall',fragmentId:'back',quote:reference}));
}
export function paperRetestSeeds(unresolved:readonly string[]):CandidateRow[]{
    return [...new Set(unresolved)].slice(0,6).map((label,index)=>({id:`retest-${index+1}`,question:`请说明这篇论文的「${label}」，并指出依据与适用边界。`,reference:'',keyPoints:'',category:'',fragmentId:'',quote:''}));
}
export function approveCandidates(source:CandidateSource,rows:readonly CandidateRow[],consent:{reviewed:boolean;workload:boolean;currentVersion:string}):CandidateArtifact{
    if(!consent.reviewed)throw Error('candidate-review-required');
    if(!consent.workload)throw Error('candidate-workload-confirmation-required');
    if(!source.version||source.version!==consent.currentVersion)throw Error('candidate-source-stale');
    if(!nonempty(source.key,500)||!nonempty(source.title,1000)||!rows.length||rows.length>6)throw Error('candidate-invalid-scope');
    const ids=new Set<string>();
    const items=rows.map(row=>{
        if(!nonempty(row.id,160)||ids.has(row.id)||!nonempty(row.question,1000)||!nonempty(row.reference,7000)||row.keyPoints.length>1000||row.reference.length+row.keyPoints.length>7900)throw Error('candidate-incomplete');
        ids.add(row.id);
        if(source.kind==='paper'&&!['claim','observation','inference','limitation'].includes(row.category))throw Error('candidate-category-required');
        if(source.kind==='paper'&&!row.keyPoints.trim())throw Error('candidate-key-points-required');
        const fragment=source.fragments.find(value=>value.id===row.fragmentId),start=fragment?.text.indexOf(row.quote)??-1;
        if(!fragment||!row.quote.trim()||start<0)throw Error('candidate-quote-not-in-source');
        return {id:row.id,question:row.question,reference:row.reference,keyPoints:row.keyPoints,category:row.category,fragmentId:row.fragmentId,quote:row.quote,citation:{fragmentId:fragment.id,label:fragment.label,start,end:start+row.quote.length,...(fragment.page?{page:fragment.page}:{})}};
    });
    return {documentType:'zhixue-practice-candidates',schemaVersion:1,status:'reviewed-candidates',parent:{key:source.key,sourceVersion:source.version,versionKind:source.versionKind,kind:source.kind,title:source.title},items};
}
/** Dedicated source artifact; never encode operators or multiline references through Markdown tables. */
export function candidateDocument(artifact:CandidateArtifact):string{return JSON.stringify(artifact,null,2)+'\n';}
