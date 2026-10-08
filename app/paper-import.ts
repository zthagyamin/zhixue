// @ts-expect-error TS5097: standalone Node regression tests.
import {parsePaperStudyData,type PaperStudyData} from './paper-study.ts';
import type {PaperOrigin,PaperSourceRead} from './paper-library-client';
export function paperFromPages(title:string,pages:{text:string;pageNumber?:number}[],origin?:PaperOrigin,sourceNote?:string):PaperStudyData{
 const bytes=pages.reduce((sum,p)=>sum+new TextEncoder().encode(p.text).length,0);if(bytes>450000)throw new Error('论文正文超过 450 KB，请按章节拆分。');
 const sections:PaperStudyData['sections']=[];let counter=0;
 for(const page of pages){const blocks=page.text.replace(/^\uFEFF/,'').replace(/\r\n?/g,'\n').replace(/\f/g,'\n\n').replace(/^---\n[\s\S]*?\n---\n/,'').split(/\n\s*\n/).filter(x=>x.trim());const paragraphs:PaperStudyData['sections'][number]['paragraphs']=[];let sectionTitle=page.pageNumber?`PDF 第 ${page.pageNumber} 页`:'正文';const flushSection=()=>{while(paragraphs.length)sections.push({id:`section-${sections.length+1}`,title:sectionTitle,paragraphs:paragraphs.splice(0,100)});};
  for(let block of blocks){const heading=!page.pageNumber?/^#{1,6}\s+([^\n]+)\n?/.exec(block):null;if(heading){flushSection();sectionTitle=heading[1].slice(0,400);block=block.slice(heading[0].length);if(!block.trim())continue;}const sentences=Array.from(new Intl.Segmenter('en',{granularity:'sentence'}).segment(block),x=>x.segment);let chunk='';const emit=()=>{if(chunk.trim())paragraphs.push({id:`p-${++counter}`,rawEn:chunk.trim(),...(page.pageNumber?{pageNumber:page.pageNumber}:{} )});chunk='';};for(let sentence of sentences){while(sentence.length>4000){if(chunk)emit();chunk=sentence.slice(0,4000);emit();sentence=sentence.slice(4000);}if(chunk.length+sentence.length>1600)emit();chunk+=sentence;}emit();}
  flushSection();
 }
 if(!counter)throw new Error('没有可读取的正文。扫描版 PDF 请先做文字识别，或上传文字版本。');
 if(sections.length>50)throw new Error('段落过多，请按章节拆分导入。');
 return parsePaperStudyData({paperId:origin?'paper:'+origin.version.slice(0,80):title.slice(0,160),title:title.slice(0,400),sourceNote,origin,sections});
}
export function paperFromSource(source:PaperSourceRead){const paper=paperFromPages(source.title,source.pages,{...source.origin,version:source.version},source.sourceNote);return source.figures?parsePaperStudyData({...paper,figures:source.figures}):paper;}
export async function importPaperFile(file:File):Promise<PaperStudyData>{
 const extension=file.name.split('.').at(-1)?.toLowerCase();if(file.size>20000000)throw new Error('文件超过 20 MB，请按章节拆分。');
 if(extension==='json'){if(file.size>500000)throw new Error('JSON 材料超过 500 KB。');const value=JSON.parse(await file.text());if(value.draft)throw new Error('这是完整草稿备份，未覆盖现有草稿。此入口用于导入论文材料。');return parsePaperStudyData(value.paper&&typeof value.paper==='object'?value.paper:value);}
 if(!['pdf','md','markdown','txt'].includes(extension??''))throw new Error('支持 PDF、Markdown、TXT 和论文 JSON。');
 const buffer=await file.arrayBuffer(),hash=await crypto.subtle.digest('SHA-256',buffer),version=Array.from(new Uint8Array(hash),x=>x.toString(16).padStart(2,'0')).join(''),origin:PaperOrigin={kind:'upload',filename:file.name,version};
 if(extension!=='pdf')return paperFromPages(file.name.replace(/\.[^.]+$/,''),[{text:new TextDecoder('utf-8',{fatal:true}).decode(buffer)}],origin);
 const pdfjs=await import('pdfjs-dist');pdfjs.GlobalWorkerOptions.workerSrc='/vendor/pdf.worker-'+pdfjs.version+'.mjs';
 const task=pdfjs.getDocument({data:new Uint8Array(buffer),enableXfa:false});let document;try{document=await task.promise;if(document.numPages>200)throw new Error('PDF 超过 200 页，请按章节拆分。');const pages=[];let length=0;for(let i=1;i<=document.numPages;i++){const page=await document.getPage(i),content=await page.getTextContent(),text=content.items.map(item=>'str' in item?item.str+(item.hasEOL?'\n':' '):'').join('');length+=text.length;if(length>450000)throw new Error('论文正文过长，请按章节拆分。');pages.push({pageNumber:i,text});}return paperFromPages(file.name.replace(/\.pdf$/i,''),pages,origin);}finally{await task.destroy();}
}
