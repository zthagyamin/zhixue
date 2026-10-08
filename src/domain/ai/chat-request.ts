// @ts-expect-error TS5097: standalone Node contracts.
import {studyObject,studyText,studyCount} from '../sync/index.ts';
import type {StudyAIChatRequest} from './types';
export function parseChatRequest(raw:unknown):StudyAIChatRequest{
 const v=studyObject(raw,['requestId','provider','model','settingsRevision','context','messages']);studyText(v.requestId,'request-id',160);if(!['deepseek','chatgpt'].includes(String(v.provider)))throw new Error('invalid-ai-provider');studyText(v.model,'ai-model',160);studyCount(v.settingsRevision,'ai-revision');
 const c=studyObject(v.context,['id','title'],['question','learnerAnswer','code','errors','pageText','selection','pageKind','truncated']);for(const key of ['id','title','question','learnerAnswer','code'])if(c[key]!==undefined)studyText(c[key],`ai-context-${key}`,key==='code'?12000:4000,true);if(c.errors!==undefined&&(!Array.isArray(c.errors)||c.errors.length>10||c.errors.some(e=>typeof e!=='string'||e.length>2000)))throw new Error('invalid-ai-context-errors');
 for(const [key,max]of [['pageText',8000],['selection',2000],['pageKind',32]] as const)if(c[key]!==undefined)studyText(c[key],key,max,true);if(c.truncated!==undefined&&typeof c.truncated!=='boolean')throw new Error('invalid-ai-context');
 if(!Array.isArray(v.messages)||v.messages.length<1||v.messages.length>30)throw new Error('invalid-ai-messages');for(const m of v.messages){const message=studyObject(m,['role','content']);if(!['user','assistant'].includes(String(message.role)))throw new Error('invalid-ai-role');studyText(message.content,'ai-content',12000);}
 if(JSON.stringify(v).length>50000)throw new Error('invalid-ai-chat-size');return structuredClone(v) as StudyAIChatRequest;
}
