import type {AssistanceObserver} from '../assistance-observer';
import type {StudyAIMessage} from './study-ai-types';

export function studyAIRepliesForContext(messages:StudyAIMessage[],contextId:string,legacyContextId?:string,loaded=true){if(!loaded)return [];return messages.filter(message=>(message.contextId??legacyContextId)===contextId);}

/** The observer deduplicates display IDs and refuses stale or sealed attempts. */
export function observeStudyAIReplies(observer:AssistanceObserver|undefined,messages:StudyAIMessage[],visible:boolean){
  if(!visible||!observer)return;
  for(const message of messages)if(message.role==='assistant'&&message.content.trim())observer.shown('ai-tutor',`sidebar:${message.id}`);
}
