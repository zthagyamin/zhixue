// @ts-expect-error TS5097: standalone Node regressions.
import {loadWorkspaceRecord,updateWorkspaceRecord} from './local-study-db.ts';
import type {TrialQuestion} from './note-trial-model';
export type SavedTrialMaterial={id:string;subject:string;title:string;questions:TrialQuestion[]};
export function matchTrialMaterials(items:readonly SavedTrialMaterial[],query:string):SavedTrialMaterial[]{
 const term=query.trim().toLocaleLowerCase();
 return items.filter(item=>!term||[item.subject,item.title,...item.questions.map(q=>q.filename)].some(value=>value.toLocaleLowerCase().includes(term)));
}
const LIMIT=50;
function cleanQuestions(questions:readonly TrialQuestion[]):TrialQuestion[]{
 if(!Array.isArray(questions)||!questions.length||questions.length>3)throw new Error('请选择 1–3 道完整试学题目。');
 return questions.map(q=>{
  if(!q||!['qa','recall'].includes(q.kind)||typeof q.id!=='string'||q.id.length>200||typeof q.prompt!=='string'||!q.prompt.trim()||q.prompt.length>1000||typeof q.answer!=='string'||!q.answer.trim()||q.answer.length>8000||typeof q.filename!=='string'||q.filename.length>180||(q.section!==null&&(typeof q.section!=='string'||q.section.length>1000)))throw new Error('材料字段不完整或过长，请重新提取题目。');
  return {id:q.id,prompt:q.prompt,answer:q.answer,filename:q.filename,section:q.section,kind:q.kind};
 });
}
function scope(owner:string,library:string):`note-trial-materials:${string}`{
 if(typeof indexedDB==='undefined')throw new Error('此浏览器目前无法保存待学材料，请保留当前页面后重试。');
 if(!owner?.trim()||!library?.trim())throw new Error('学习空间尚未确认，请稍后保存。');
 return `note-trial-materials:${JSON.stringify(library)}`;
}
function parse(raw:unknown):SavedTrialMaterial[]{
 if(!Array.isArray(raw)||raw.length>LIMIT)throw new Error('待学材料尚未完整读取，原内容保留。');
 return raw.map(value=>{if(!value||typeof value.id!=='string'||!/^trial-[a-f0-9]{64}$/.test(value.id)||typeof value.subject!=='string'||!value.subject.trim()||value.subject.length>80||typeof value.title!=='string'||!value.title.trim()||value.title.length>180)throw new Error('待学材料尚未完整读取，原内容保留。');return {id:value.id,subject:value.subject,title:value.title,questions:cleanQuestions(value.questions)};});
}
export async function loadTrialMaterials(owner:string,library:string){return parse(await loadWorkspaceRecord<unknown>(owner,scope(owner,library),[]));}
export async function saveTrialMaterial(owner:string,library:string,subject:string,title:string,questions:readonly TrialQuestion[]){
 const kind=scope(owner,library);
 if(!subject.trim()||subject.length>80||!title.trim()||title.length>180)throw new Error('请填写学科和材料名称。');
 const body={subject:subject.trim(),title:title.trim(),questions:cleanQuestions(questions)};
 const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(body)));
 const entry={id:'trial-'+Array.from(new Uint8Array(digest),v=>v.toString(16).padStart(2,'0')).join(''),...body};
 await updateWorkspaceRecord<unknown>(owner,kind,[],raw=>{const previous=parse(raw),rest=previous.filter(value=>value.id!==entry.id);if(rest.length>=LIMIT)throw new Error('本学习库已保存 50 份待学材料，请先移除不需要的材料。');return [entry,...rest];});
 if(!(await loadTrialMaterials(owner,library)).some(value=>value.id===entry.id))throw new Error('保存结果未能核对，请重试；当前题目仍保留。');
 return entry;
}
export async function removeTrialMaterial(owner:string,library:string,id:string){
 await updateWorkspaceRecord<unknown>(owner,scope(owner,library),[],raw=>parse(raw).filter(value=>value.id!==id));
}
