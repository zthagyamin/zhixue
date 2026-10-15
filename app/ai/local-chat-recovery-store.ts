// @ts-expect-error TS5097: standalone Node contracts.
import {ChatRecoveryJournal} from '../../src/application/ai/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {loadWorkspaceRecord,updateWorkspaceRecord} from '../local-study-db.ts';
import type {StudyAIScope} from './study-ai-types';

export function createLocalChatRecovery(scope:StudyAIScope,conversationKey:string){
 const workspace='study-ai-recovery:'+JSON.stringify([scope.mode,scope.ownerId,scope.libraryId]);
 const kind=`ai-chat-recovery:v1:${conversationKey}` as const;
 return new ChatRecoveryJournal(JSON.stringify([scope.mode,scope.ownerId,scope.libraryId,conversationKey]),{
  load:async()=>{if(typeof indexedDB==='undefined')throw Error('ai-chat-storage-unavailable');
   try{return await loadWorkspaceRecord(workspace,kind,null,{requireValue:true});}
   catch(error){if(error instanceof Error&&error.message==='workspace-record-value-invalid')throw Error('ai-chat-recovery-invalid');throw Error('ai-chat-storage-unavailable');}},
  change:async update=>{try{await updateWorkspaceRecord<unknown>(workspace,kind,null,update,{requireValue:true});}
   catch(error){if(error instanceof Error&&error.message.startsWith('ai-'))throw error;
    if(error instanceof Error&&error.message==='workspace-record-value-invalid')throw Error('ai-chat-recovery-invalid');throw Error('ai-chat-storage-unavailable');}},
 });
}
