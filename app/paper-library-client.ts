import type {PaperStudyData} from './paper-study';
import type {PaperFigure} from './paper-figures';
export type PaperOrigin={kind:'vault'|'notion'|'upload';path?:string;sourceId?:string;sourceRevision?:number;pageId?:string;url?:string;filename?:string;version:string};
export type PaperDocument={kind:'vault'|'notion';title:string;path?:string;sourceId?:string;sourceRevision?:number;pageId?:string;url?:string};
export type PaperSourceRead={title:string;pages:{text:string;pageNumber?:number}[];version:string;sourceNote?:string;origin:Omit<PaperOrigin,'version'>;figures?:PaperFigure[];figuresStatus?:'unavailable'};
export type PaperFigureAsset={assetId:string;sourceVersion:string;assetVersion:string;mime:'image/png'|'image/jpeg'|'application/pdf';data:string};
export type PaperOriginalPageAsset={sourceVersion:string;page:number;mime:'application/pdf';data:string;assetVersion:string};
export type PaperDestination={kind:'obsidian';directory:string;label?:string}|{kind:'notion';sourceId:string;sourceRevision:number;label?:string;url?:string};
export type PaperLibraryCatalog={localLibraryId:string;accountLibraryId:string|null;documents:PaperDocument[];destinations:PaperDestination[];limited:boolean};
export type PaperNoteRequest={requestId:string;localLibraryId:string;accountLibraryId?:string;destination:PaperDestination;title:string;markdown:string;source?:PaperOrigin};
export type PaperNoteReceipt={requestId:string;localLibraryId:string;status:'written';kind:'obsidian'|'notion';path?:string;url?:string};
export type PaperLibraryScope={localLibraryId:string;accountLibraryId?:string};
export function verifiedPaperScope(catalog:PaperLibraryCatalog,expected:{localLibraryId?:string;accountLibraryId?:string}):PaperLibraryScope{if(!catalog||typeof catalog.localLibraryId!=='string'||!catalog.localLibraryId||(expected.accountLibraryId?catalog.accountLibraryId!==expected.accountLibraryId:expected.localLibraryId&&catalog.localLibraryId!==expected.localLibraryId))throw new Error('当前资料库与 Companion 不一致，请切回对应资料库。');return{localLibraryId:catalog.localLibraryId,...(expected.accountLibraryId?{accountLibraryId:expected.accountLibraryId}:{})};}
export type PaperFigureRequest=PaperLibraryScope&{assetId:string;assetVersion:string}&({source:PaperOrigin}|{sourceKey:string;sourceVersion:string});
export type PaperLibraryClient={catalog:(query?:string,signal?:AbortSignal)=>Promise<PaperLibraryCatalog>;read:(source:PaperDocument,scope:PaperLibraryScope)=>Promise<PaperSourceRead>;figure?:(payload:PaperFigureRequest,signal?:AbortSignal)=>Promise<PaperFigureAsset>;originalPage?:(payload:PaperLibraryScope&{source:PaperOrigin;page:number},signal?:AbortSignal)=>Promise<PaperOriginalPageAsset>;material:(payload:PaperLibraryScope&{paper:PaperStudyData})=>Promise<{sourceNote:string;localLibraryId:string}>;save:(request:PaperNoteRequest)=>Promise<PaperNoteReceipt>};
const ERRORS:Record<string,string>={'paper-path-too-long':'保存目录过深，请选择更短的学习库内目录。','paper-source-changed':'来源已更新。请保留当前草稿，重新读取原文后核对。','paper-library-changed':'资料库已切换，请回到对应资料库后重试。','paper-no-extractable-text':'未能提取正文，扫描版请先进行文字识别。','paper-material-too-large':'材料过大，请按章节拆分后导入。','paper-pdf-unavailable':'PDF 无法读取，可能已加密或超过 200 页。','paper-notion-not-connected':'该 Notion 来源未连接或已停用。','paper-notion-write-disabled':'请在资料连接中设置 Notion 的记录位置。','paper-notion-write-uncertain':'Notion 保存结果待核对。请保留原请求并重试，避免重复创建。','paper-note-edited':'目标笔记已变化，已停止覆盖。请核对原笔记。','paper-path-outside-library':'请选择本机学习库内的普通目录。','paper-source-unavailable':'来源文件当前无法读取。'};
export class PaperLibraryError extends Error{noWrite:boolean;constructor(message:string,noWrite=false){super(message);this.noWrite=noWrite;}}
ERRORS['paper-original-page-unavailable']='此来源的原页当前不可用，请提供匹配的原 PDF。';
ERRORS['paper-invalid-page']='原页页码无效，请选择论文中的实际页码。';
export function createPaperLibraryClient(baseUrl:string,token:string,fetcher:typeof fetch=fetch):PaperLibraryClient{
 const url=new URL(baseUrl);if(!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||!['http:','https:'].includes(url.protocol)||url.username||url.password||!token.trim())throw new Error('请连接本机 Companion。');
 async function request<T>(path:string,body?:unknown,signal?:AbortSignal):Promise<T>{
  const response=await fetcher(new URL(path,url),{
   method:body?'POST':'GET',
   headers:{'X-Study-Loop-Session':token,...(body?{'Content-Type':'application/json'}:{})},
   signal:signal?AbortSignal.any([signal,AbortSignal.timeout(150000)]):AbortSignal.timeout(150000),
   ...(body?{body:JSON.stringify(body)}:{}),cache:'no-store',
  });
  if(path==='/v1/papers/page'&&response.status===404){
   throw new PaperLibraryError('请更新 Companion 以读取论文原页。');
  }
  let value:unknown;
  try{value=await response.json();}catch{throw new Error('资料响应不完整，已保留本机草稿。');}
  if(!response.ok){
   const details=value as {message?:string;noWrite?:boolean},message=details.message??'';
   throw new PaperLibraryError(
    response.status===404?'请更新 Companion 以读取论文来源和保存阅读笔记。':ERRORS[message]??'资料操作尚未完成，请核对来源连接；本机草稿保留。',
    response.status===409&&details.noWrite===true,
   );
  }
  return value as T;
 }
 async function originalPage(
  payload:PaperLibraryScope&{source:PaperOrigin;page:number},
  signal?:AbortSignal,
 ):Promise<PaperOriginalPageAsset>{
  signal?.throwIfAborted();
  const snapshot=structuredClone(payload);
  if(!snapshot
   ||typeof snapshot.localLibraryId!=='string'||!snapshot.localLibraryId.trim()
   ||(snapshot.accountLibraryId!==undefined&&(typeof snapshot.accountLibraryId!=='string'||!snapshot.accountLibraryId.trim()))
   ||!Number.isInteger(snapshot.page)||snapshot.page<1||snapshot.page>200){
   throw new PaperLibraryError('原页请求的资料库或页码无效。');
  }
  const source=snapshot.source;
  if(!source||source.kind!=='vault'||typeof source.path!=='string'||!source.path.toLowerCase().endsWith('.pdf')){
   throw new PaperLibraryError('此来源的原页当前不可用，请提供匹配的原 PDF。');
  }
  const excluded=['_system','_archive','backups','node_modules','__pycache__'];
  if(typeof source.version!=='string'||!/^[a-f0-9]{64}$/.test(source.version)
   ||source.path.length>500||/[:\\]/.test(source.path)||Array.from(source.path).some(char=>char.charCodeAt(0)<32)
   ||source.path.split('/').some(part=>!part||part.startsWith('.')||excluded.includes(part.toLowerCase()))){
   throw new PaperLibraryError('原页来源或版本无效，请重新核对原文。');
  }
  let value:unknown;
  try{
   value=await request<unknown>('/v1/papers/page',snapshot,signal);
  }catch(error){
   signal?.throwIfAborted();
   if(error instanceof PaperLibraryError&&error.message.startsWith('请更新 Companion')){
    throw new PaperLibraryError('请更新 Companion 以读取论文原页。');
   }
   throw error;
  }
  signal?.throwIfAborted();
  const fail=()=>new PaperLibraryError('原页响应不完整或与当前来源不一致，请重新核对原文。');
  if(!value||typeof value!=='object'||Array.isArray(value))throw fail();
  const asset=value as Record<string,unknown>;
  if(Object.keys(asset).sort().join(',')!=='assetVersion,data,mime,page,sourceVersion'
   ||asset.sourceVersion!==source.version||asset.page!==snapshot.page||asset.mime!=='application/pdf'
   ||typeof asset.assetVersion!=='string'||!/^[a-f0-9]{64}$/.test(asset.assetVersion)
   ||typeof asset.data!=='string'||!asset.data||asset.data.length>Math.ceil(20000000/3)*4
   ||asset.data.length%4!==0||!/^[A-Za-z0-9+/]*={0,2}$/.test(asset.data)){
   throw fail();
  }
  const decoded=atob(asset.data);
  if(decoded.length>20000000||btoa(decoded)!==asset.data||!decoded.startsWith('%PDF-'))throw fail();
  const bytes=Uint8Array.from(decoded,char=>char.charCodeAt(0));
  const digest=await crypto.subtle.digest('SHA-256',bytes);
  const hash=Array.from(new Uint8Array(digest),byte=>byte.toString(16).padStart(2,'0')).join('');
  signal?.throwIfAborted();
  if(hash!==asset.assetVersion)throw fail();
  return{sourceVersion:source.version,page:snapshot.page,mime:'application/pdf',data:asset.data,assetVersion:hash};
 }
 return{catalog:(query='',signal)=>request('/v1/papers?query='+encodeURIComponent(query),undefined,signal),read:(source,scope)=>request('/v1/papers/read',{source,...scope}),figure:(payload,signal)=>request('/v1/papers/figure',payload,signal),originalPage,material:payload=>request('/v1/papers/material',payload),save:payload=>request('/v1/papers/save',payload)};
}
