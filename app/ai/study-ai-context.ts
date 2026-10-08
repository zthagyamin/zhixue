import type {StudyAIContext,StudyAIMessage,StudyAIChatRequest,StudyAISettings} from './study-ai-types';

export function normalizeStudyAIContext(value:StudyAIContext):StudyAIContext{
 let truncated=Boolean(value.truncated);
 const cut=(text:string|undefined,max:number)=>{if(text===undefined)return undefined;if(text.length>max)truncated=true;return text.slice(0,max);};
 const result:StudyAIContext={id:cut(value.id,240)!,title:cut(value.title,160)!};
 for(const [key,max]of [['question',4000],['learnerAnswer',4000],['code',12000],['pageText',8000],['selection',2000],['pageKind',32]] as const){const text=cut(value[key],max);if(text)result[key]=text;}
 if(value.errors?.length){if(value.errors.length>5)truncated=true;result.errors=value.errors.slice(0,5).map(error=>cut(error,1200)!);}
 if(truncated)result.truncated=true;
 return result;
}
export function buildStudyAIRequest(settings:Pick<StudyAISettings,'provider'|'model'|'revision'>,context:StudyAIContext,messages:StudyAIMessage[],requestId:string):StudyAIChatRequest{
 const selected:Array<{role:'user'|'assistant';content:string}>=[];let budget=18000;
 for(const message of [...messages].reverse()){if(!message.content.trim())continue;const content=message.content.slice(-Math.min(12000,budget));if(!content)break;selected.unshift({role:message.role,content});budget-=content.length;if(budget<=0||selected.length===30)break;}
 const request:StudyAIChatRequest={requestId,provider:settings.provider,model:settings.model,settingsRevision:settings.revision,context:normalizeStudyAIContext(context),messages:selected};
 while(JSON.stringify(request).length>48000&&request.messages.length>1)request.messages.shift();
 while(JSON.stringify(request).length>48000){const key=(['pageText','code','question','learnerAnswer','selection'] as const).find(key=>(request.context[key]?.length??0)>100);if(!key)break;request.context[key]=request.context[key]!.slice(0,Math.floor(request.context[key]!.length/2));request.context.truncated=true;}
 return request;
}
