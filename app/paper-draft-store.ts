// @ts-expect-error TS5097: Node tests require explicit TypeScript extension.
import {loadWorkspaceRecord,updateWorkspaceRecord,type WorkspaceRecordKind} from './local-study-db.ts';
// @ts-expect-error TS5097: Node tests require explicit TypeScript extension.
import {emptyPaperDraft,parsePaperStudyData,type PaperDraft,type PaperStudyData} from './paper-study.ts';
export async function paperFingerprint(paper:PaperStudyData){const canonical=JSON.stringify(parsePaperStudyData(paper));const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical));return Array.from(new Uint8Array(bytes),v=>v.toString(16).padStart(2,'0')).join('');}
type Stored={paper:PaperStudyData;draft:PaperDraft};
export type PaperDraftState={draft:PaperDraft;ready:boolean;saving:boolean;error:string;dirty:boolean};
const sessions=new Map<string,PaperDraftSession>();
export class PaperDraftSession{
 private operations=new Map<string,Promise<unknown>>();
 isExclusive(name:string){return this.operations.has(name);}
 exclusive<T>(name:string,action:()=>Promise<T>):Promise<T>{const existing=this.operations.get(name);if(existing)return existing as Promise<T>;const operation=Promise.resolve().then(action).finally(()=>{if(this.operations.get(name)===operation){this.operations.delete(name);this.emit({...this.state});}});this.operations.set(name,operation);this.emit({...this.state});return operation;}
 readonly owner:string;readonly kind:WorkspaceRecordKind;readonly paper:PaperStudyData;
 private listeners=new Set<()=>void>();private state:PaperDraftState={draft:emptyPaperDraft(),ready:false,saving:false,error:'',dirty:false};private queue:Promise<void>=Promise.resolve();private diskRevision=0;private loaded:Promise<void>;
 constructor(owner:string,kind:WorkspaceRecordKind,paper:PaperStudyData){this.owner=owner;this.kind=kind;this.paper=paper;this.loaded=this.load();}
 snapshot=()=>this.state;
 subscribe=(listener:()=>void)=>{this.listeners.add(listener);return()=>{this.listeners.delete(listener);};};
 private emit(next:PaperDraftState){this.state=next;for(const listener of this.listeners)listener();}
 private async load(){try{if(typeof indexedDB==='undefined')throw new Error('此浏览器无法保存草稿，请在离开前导出。');const stored=await loadWorkspaceRecord<Stored|null>(this.owner,this.kind,null);if(stored){this.diskRevision=stored.draft.revision;this.emit({draft:stored.draft,ready:true,saving:false,error:'',dirty:false});}else this.emit({...this.state,ready:true});}catch(error){this.emit({...this.state,ready:true,error:String(error)});}}
 update(change:(draft:PaperDraft)=>PaperDraft){if(!this.state.ready)throw new Error('草稿尚未读取。');const draft=structuredClone(change(this.state.draft));this.emit({...this.state,draft,saving:true,dirty:true});this.queue=this.queue.then(async()=>{if(this.state.error)throw new Error(this.state.error);await updateWorkspaceRecord<Stored|null>(this.owner,this.kind,null,current=>{if((current?.draft.revision??0)!==this.diskRevision)throw new Error('另一标签页已更新这篇草稿。当前输入已保留，请导出完整草稿，再刷新整个网页读取已保存版本。');return{paper:this.paper,draft:{...draft,revision:this.diskRevision+1}};});this.diskRevision++;}).catch(error=>{this.emit({...this.state,error:String(error),saving:false});}).then(()=>{if(this.state.draft===draft)this.emit({...this.state,saving:false,dirty:!!this.state.error});});return this.queue;}
 async flush(){await this.loaded;await this.queue;if(this.state.error)throw new Error(this.state.error);}
}
export async function openPaperDraft(owner:string,library:string,paper:PaperStudyData){const fingerprint=await paperFingerprint(paper),kind=`paper-draft:${JSON.stringify([library,fingerprint])}` as WorkspaceRecordKind,key=JSON.stringify([owner,kind]);let session=sessions.get(key);if(!session){session=new PaperDraftSession(owner,kind,paper);sessions.set(key,session);}return session;}
export type PaperMaterial={fingerprint:string;paper:PaperStudyData};
export async function savePaperMaterial(owner:string,library:string,paper:PaperStudyData){const material={fingerprint:await paperFingerprint(paper),paper:parsePaperStudyData(paper)};await updateWorkspaceRecord<PaperMaterial[]>(owner,`paper-document:${library}`,[],current=>{if(current.length>=30&&!current.some(x=>x.fingerprint===material.fingerprint))throw new Error('当前资料库已保存 30 个材料版本，请另建资料库或导出整理。');return[material,...current.filter(x=>x.fingerprint!==material.fingerprint)];});return material;}
export async function loadPaperMaterials(owner:string,library:string){return loadWorkspaceRecord<PaperMaterial[]>(owner,`paper-document:${library}`,[]);}
if(typeof window!=='undefined')window.addEventListener('beforeunload',event=>{if([...sessions.values()].some(s=>s.snapshot().saving||s.snapshot().dirty)){event.preventDefault();event.returnValue='';}});
