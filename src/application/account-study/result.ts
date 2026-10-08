import type {StudyAIStreamEvent} from '../../domain/ai';
export type AccountStreamEvent=StudyAIStreamEvent|{type:'error';error:string};
export type AccountReply={kind:'value';value:unknown;status:number}|{
  kind:'stream';events:AsyncIterable<AccountStreamEvent>;cancel:()=>void;
};
export const accountValue=(value:unknown,status=200):AccountReply=>({kind:'value',value,status});
