// @ts-expect-error TS5097: standalone Node contracts.
import {parseChatRequest} from '../../domain/ai/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {studyObject,studyText,studyCount} from '../../domain/sync/index.ts';
import type {StudyAIChatRequest,StudyAIMessage,StudyAIStreamEvent} from '../../domain/ai';
import type {StudyAIService} from './ports';

export type ChatRecoveryEntry={request:StudyAIChatRequest;user:StudyAIMessage;answer:StudyAIMessage;
 state:'saved'|'pending'|'done';generation:number};
export type ChatRecoveryCandidate=Pick<ChatRecoveryEntry,'request'|'user'|'answer'>;
type State={schemaVersion:1;scopeKey:string;entries:ChatRecoveryEntry[]};
export interface ChatRecoveryPort{load():Promise<unknown>;change(update:(value:unknown)=>State):Promise<void>}

function canonical(value:unknown):string{
 if(Array.isArray(value))return '['+value.map(canonical).join(',')+']';
 if(value&&typeof value==='object')return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+canonical((value as Record<string,unknown>)[key])).join(',')+'}';
 return JSON.stringify(value)??'null';
}
function message(raw:unknown,role:'user'|'assistant'):StudyAIMessage{
 const row=studyObject(raw,['id','role','content'],['model','provider','contextId','contextTitle']);
 studyText(row.id,'chat-message-id',160);studyText(row.content,'chat-message',role==='user'?12000:50000,true);
 if(row.role!==role)throw Error('ai-chat-recovery-invalid');
 for(const key of ['model','contextId','contextTitle'])if(row[key]!==undefined)studyText(row[key],key,key==='model'?160:4000,true);
 if(row.provider!==undefined&&!['deepseek','chatgpt'].includes(String(row.provider)))throw Error('ai-chat-recovery-invalid');
 return structuredClone(row) as StudyAIMessage;
}
function entry(raw:unknown):ChatRecoveryEntry{
 const row=studyObject(raw,['request','user','answer','state','generation']);
 const request=parseChatRequest(row.request),user=message(row.user,'user'),answer=message(row.answer,'assistant');
 studyCount(row.generation,'chat-generation');
 if(!['saved','pending','done'].includes(String(row.state))||user.id===answer.id||
    user.content!==request.messages.at(-1)?.content||user.contextId!==answer.contextId||
    (answer.provider!==undefined&&answer.provider!==request.provider))throw Error('ai-chat-recovery-invalid');
 return {request,user,answer,state:row.state as ChatRecoveryEntry['state'],generation:row.generation as number};
}

/** Storage completes before network or display. No scheduling, grades or platform APIs. */
export class ChatRecoveryJournal{
 private scopeKey:string;
 private port:ChatRecoveryPort;
 constructor(scopeKey:string,port:ChatRecoveryPort){studyText(scopeKey,'chat-scope',4000);this.scopeKey=scopeKey;this.port=port;}
 private parse(raw:unknown):State{
  if(raw===null)return {schemaVersion:1,scopeKey:this.scopeKey,entries:[]};
  try{
   const row=studyObject(raw,['schemaVersion','scopeKey','entries']);
   if(row.schemaVersion!==1||row.scopeKey!==this.scopeKey||!Array.isArray(row.entries)||row.entries.length>200)throw Error();
   const entries=row.entries.map(entry),requests=new Set<string>(),messages=new Set<string>();
   for(const item of entries){if(requests.has(item.request.requestId)||messages.has(item.user.id)||messages.has(item.answer.id))throw Error();
    requests.add(item.request.requestId);messages.add(item.user.id);messages.add(item.answer.id);}
   return {schemaVersion:1,scopeKey:this.scopeKey,entries};
  }catch{throw Error('ai-chat-recovery-invalid');}
 }
 async load(){return structuredClone(this.parse(await this.port.load()).entries);}
 private async change(update:(rows:ChatRecoveryEntry[])=>ChatRecoveryEntry){
  let result:ChatRecoveryEntry|undefined;
  await this.port.change(value=>{const state=this.parse(value);result=update(state.entries);return this.parse(state);});
  if(!result)throw Error('ai-chat-storage-unavailable');
  return structuredClone(result);
 }
 async prepare(candidate:ChatRecoveryCandidate){
  const incoming=entry({...candidate,state:'saved',generation:0});
  return this.change(rows=>{
   const same=rows.find(row=>row.request.requestId===incoming.request.requestId);
   if(same){if(canonical(same.request)!==canonical(incoming.request)||same.user.id!==incoming.user.id||same.answer.id!==incoming.answer.id)throw Error('ai-request-conflict');return same;}
   const content=canonical([incoming.request.context,incoming.request.messages]);
   const pending=rows.find(row=>row.state!=='done'&&canonical([row.request.context,row.request.messages])===content);
   if(pending)return pending;
   if(rows.length>=200)throw Error('ai-chat-recovery-full');
   rows.push(incoming);return incoming;
  });
 }
 private async begin(requestId:string){
  return this.change(rows=>{const row=rows.find(value=>value.request.requestId===requestId);
   if(!row)throw Error('ai-request-conflict');
   if(row.state!=='done'){row.generation++;row.state='pending';}
   return row;
  });
 }
 private async apply(ticket:ChatRecoveryEntry,text:string,done?:Extract<StudyAIStreamEvent,{type:'done'}>){
  return this.change(rows=>{
   const row=rows.find(value=>value.request.requestId===ticket.request.requestId);
   if(!row||row.generation!==ticket.generation||row.state!=='pending')throw Error('ai-request-conflict');
   const saved=row.answer.content;
   if(!saved.startsWith(text)&&!text.startsWith(saved))throw Error('ai-chat-response-conflict');
   if(done&&text.length<saved.length)throw Error('ai-stream-incomplete');
   if(text.length>=saved.length)row.answer.content=text;
   if(done){if(done.provider!==undefined&&done.provider!==row.request.provider)throw Error('ai-chat-response-conflict');
    row.answer.provider=row.request.provider;if(done.model!==undefined)row.answer.model=done.model;row.state='done';}
   return row;
  });
 }
 async *run(requestId:string,service:Pick<StudyAIService,'chat'>,signal:AbortSignal):AsyncGenerator<ChatRecoveryEntry>{
  signal.throwIfAborted();const ticket=await this.begin(requestId);signal.throwIfAborted();
  if(ticket.state==='done'){yield ticket;return;}
  let text='',done:Extract<StudyAIStreamEvent,{type:'done'}>|undefined;
  for await(const event of service.chat(structuredClone(ticket.request),signal)){
   signal.throwIfAborted();if(done)throw Error('ai-stream-invalid');
   if(event.type==='delta'){
    if(typeof event.text!=='string')throw Error('ai-stream-invalid');text+=event.text;if(text.length>50000)throw Error('ai-stream-limit');
    const saved=await this.apply(ticket,text);signal.throwIfAborted();yield saved;
   }else if(event.type==='done')done=event;else throw Error('ai-stream-invalid');
  }
  signal.throwIfAborted();if(!done)throw Error('ai-stream-incomplete');
  const saved=await this.apply(ticket,text,done);signal.throwIfAborted();yield saved;
 }
}

export function mergeChatRecovery(history:StudyAIMessage[],entries:ChatRecoveryEntry[]){
 const ordered=entries.flatMap(row=>[row.user,row.answer]);
 const positions=new Map(ordered.map((row,index)=>[row.id,index]));
 const result:StudyAIMessage[]=[];let cursor=0;
 for(const item of history){
  const index=positions.get(item.id);
  if(index===undefined)result.push(structuredClone(item));
  else if(index>=cursor){result.push(...structuredClone(ordered.slice(cursor,index+1)));cursor=index+1;}
 }
 result.push(...structuredClone(ordered.slice(cursor)));
 return result;
}
