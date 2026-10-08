/** A bounded, deterministic local preview, not AI generation or a vault import. */
export const TRIAL_FILE_LIMIT=2;
export const TRIAL_BYTE_LIMIT=256*1024;
export const TRIAL_QUESTION_LIMIT=3;
export type TrialSource={name:string;text:string};
export type TrialQuestion={id:string;prompt:string;answer:string;filename:string;section:string|null;kind:'qa'|'recall'};
export function validateTrialFiles(files:readonly {name:string;size:number}[]):string|null{
 if(!files.length||files.length>TRIAL_FILE_LIMIT)return '请选择 1–2 个 Markdown 或 TXT 文件。';
 if(files.some(file=>!/\.(?:md|markdown|txt)$/i.test(file.name)))return '仅支持 .md、.markdown 和 .txt 文件。';
 if(files.some(file=>!Number.isFinite(file.size)||file.size<=0||file.size>TRIAL_BYTE_LIMIT))return '请选取有正文的文件，单个文件最多 256 KB。';
 return null;
}
export function extractTrialQuestions(sources:readonly TrialSource[]):TrialQuestion[]{
 if(!sources.length||sources.length>TRIAL_FILE_LIMIT)throw new Error('一次试学 1–2 份材料。');
 const bySource=sources.map((source,sourceIndex)=>{
  if(typeof source.text!=='string'||new TextEncoder().encode(source.text).length>TRIAL_BYTE_LIMIT)throw new Error('材料过长，请先选取一个章节（最多 256 KB）。');
  if(source.text.includes('\0'))throw new Error('文件包含非文本内容，请另存为 UTF-8 文本。');
  const filename=source.name.replace(/[\\/]/g,' ').trim().slice(0,180)||'粘贴的笔记';
  const text=source.text.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n').replace(/^---\n[\s\S]*?\n---(?:\n|$)/,'');
  let section:string|null=null,fence:string|null=null,inComment=false;
  const sections:{section:string|null;lines:string[]}[]=[];let lines:string[]=[];
  const flush=()=>{if(lines.length){sections.push({section,lines});lines=[];}};
  for(const raw of text.split('\n')){
   const line=raw.replace(/^\s*>\s?/,'');
   if(inComment){if(line.includes('-->'))inComment=false;continue;}
   if(line.trimStart().startsWith('<!--')){inComment=!line.includes('-->');continue;}
   const marker=/^\s*(`{3,}|~{3,})/.exec(line);
   if(marker){if(!fence)fence=marker[1][0];else if(marker[1][0]===fence)fence=null;continue;}
   if(fence||/^\s*(?:!\[|\[!)/.test(line))continue;
   const heading=/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
   if(heading){flush();section=heading[1];continue;}
   lines.push(line);
  }
  flush();
  const explicit:TrialQuestion[]=[],fallback:TrialQuestion[]=[];
  for(let i=0;i<sections.length;i++){
   const part=sections[i],joined=part.lines.join('\n');
   // Retain answers exactly as text; blank lines and quoted Q/A are supported.
   const matches=[...joined.matchAll(/(?:^|\n)(?:Q|问|问题)\s*[:：]\s*([^\n]+)\n\s*(?:A|答|答案)\s*[:：]\s*([\s\S]*?)(?=\n\s*(?:Q|问|问题)\s*[:：]|$)/gi)];
   for(const match of matches){
    const prompt=match[1].trim(),answer=match[2].trim();
    if(prompt&&answer&&prompt.length<=1000&&answer.length<=8000)explicit.push({id:`trial-${sourceIndex}-${i}-qa-${explicit.length}`,prompt,answer,filename,section:part.section,kind:'qa'});
   }
   for(const block of joined.split(/\n\s*\n/).map(value=>value.trim()).filter(value=>value.length>=20&&value.length<=8000)){
    if(/^(?:Q|问|问题|A|答|答案)\s*[:：]/i.test(block))continue;
    fallback.push({id:`trial-${sourceIndex}-${i}-recall-${fallback.length}`,prompt:`不看原文，用自己的话概括${part.section?`“${part.section}”`:'这一段'}的主要内容与重要条件。`,answer:block,filename,section:part.section,kind:'recall'});
   }
  }
  return explicit.length?explicit:fallback;
 });
 // Give each supplied file a turn instead of silently ignoring the second file.
 const result:TrialQuestion[]=[];
 for(let round=0;result.length<TRIAL_QUESTION_LIMIT;round++){
  let found=false;for(const candidates of bySource){if(candidates[round]&&result.length<TRIAL_QUESTION_LIMIT){result.push(candidates[round]);found=true;}}
  if(!found)break;
 }
 return result;
}
