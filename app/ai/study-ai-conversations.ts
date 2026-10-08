import type {StudyAIScope,StudyAIProvider} from './study-ai-types';
// @ts-expect-error Node contract tests use explicit extensions.
import {readStudyAIHistory} from './study-ai-service.ts';
export function legacyStudyAIContextId(key:string):string|undefined{
 if(!key.startsWith('study-ai-chat-v1:'))return;
 try{const fields=JSON.parse(key.slice('study-ai-chat-v1:'.length)),value=fields?.[4];if(typeof value!=='string'||/^(workspace:|workspace-index|index:)/.test(value))return;const split=value.lastIndexOf(':');if(split>0&&/^[A-Za-z0-9-]{1,80}$/.test(value.slice(split+1)))return value.slice(0,split);}catch{/* Unknown old history is not bound to a current attempt. */}
}
/** Keep existing per-page conversations accessible without touching other owners' history. */
export function legacyStudyAIConversations(storage:Pick<Storage,'length'|'key'|'getItem'>,scope:StudyAIScope,provider:StudyAIProvider){
 const result:Array<{id:string;key:string;label:string}>=[];
 for(let index=0;index<storage.length&&result.length<100;index++){
  const key=storage.key(index);if(!key?.startsWith('study-ai-chat-v1:'))continue;
  let fields;try{fields=JSON.parse(key.slice('study-ai-chat-v1:'.length));}catch{continue;}
  if(!Array.isArray(fields)||fields[0]!==scope.mode||fields[1]!==scope.ownerId||fields[2]!==scope.libraryId||fields[3]!==provider||typeof fields[4]!=='string'||/^(index:|workspace:|workspace-index$)/.test(fields[4]))continue;
  const messages=readStudyAIHistory(storage,key);if(!messages.length)continue;
  result.push({id:`legacy:${key}`,key,label:`旧对话 · ${messages.find(message=>message.role==='user')?.content.slice(0,24)||result.length+1}`});
 }
 return result;
}
