import type {StudyAIService,StudyAISettings} from './study-ai-types';
// @ts-expect-error Node contract tests use explicit extensions.
import {StudyAIRequestGate} from './study-ai-service.ts';
// @ts-expect-error Node contract tests use explicit extensions.
import {studyAIErrorMessage} from './study-ai-errors.ts';
export type StudyAIConnectionState={state:'testing'|'connected'|'error';revision:number;model:string;provider:string;latencyMs?:number;message?:string};
export function createStudyAIConnectionTester(service:Pick<StudyAIService,'testConnection'>,publish:(state:StudyAIConnectionState|null)=>void){
 const gate=new StudyAIRequestGate();let active=true;
 return {
  reset(){active=true;gate.invalidate();publish(null);},
  dispose(){active=false;gate.invalidate();},
  async run(value:Pick<StudyAISettings,'provider'|'model'|'revision'>){
   if(!active)return false;const task=gate.begin(),base={revision:value.revision,model:value.model,provider:value.provider};publish({...base,state:'testing'});
   try{const result=await service.testConnection(value,task.signal);if(!active||!task.current())return false;publish({...base,...result,state:'connected'});return true;}
   catch(error){if(active&&task.current())publish({...base,state:'error',message:studyAIErrorMessage(error)});return false;}
  },
 };
}
