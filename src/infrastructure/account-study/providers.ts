import type {StudyScope} from '../../application/account-study';
import type {StudyAIProvider,StudyAISettings,StudyAIModelSelection} from '../../domain/ai';
// @ts-expect-error TS5097: standalone Node contracts.
import {accountStudyPlanAiTrace,accountStudyQuestionAiTrace} from '../../domain/ai/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {createStudyAIChat,createAccountStudyPlanAi,createAccountStudyQuestionAi,listProviderModels} from '../ai/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {createCourseTaskAi} from '../course-ai/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {courseEvaluationTrace} from '../../domain/course-ai/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {evaluationFingerprint} from '../learning-attempt/index.ts';

// @ts-expect-error TS5097: standalone Node contracts.
import {createPracticeAssistanceAi} from '../math-study/index.ts';

export interface ProviderCredentials{
  getSettings(scope:StudyScope):Promise<StudyAISettings>;
  providerKey(scope:StudyScope,revision?:number,provider?:StudyAIProvider):Promise<string>;
}
/** Only this adapter obtains credentials; application use cases receive configured services. */
export function createAccountProviderServices(ports:{
  store:()=>ProviderCredentials;configuration:()=>{enabled:boolean;configured:boolean;defaultModel:string};fetcher?:typeof fetch;
}){
  async function providerOptions(scope:StudyScope,expectedRevision?:number){
    const store=ports.store(),settings=await store.getSettings(scope);
    if(expectedRevision!==undefined&&settings.revision!==expectedRevision)throw Error('ai-settings-stale');
    const config=ports.configuration();
    return{enabled:settings.enabled&&config.enabled,key:await store.providerKey(scope,settings.revision),provider:settings.provider,
      baseUrl:settings.baseUrl,model:settings.model||(settings.provider==='deepseek'?config.defaultModel:''),...(ports.fetcher?{fetcher:ports.fetcher}:{})};
  }
  return{
    getPlanAiTrace:()=>accountStudyPlanAiTrace(ports.configuration().defaultModel),
    getQuestionAiTrace:()=>accountStudyQuestionAiTrace(ports.configuration().defaultModel),
    getCourseAiTrace:()=>courseEvaluationTrace(ports.configuration().defaultModel),
    getPracticeAi:async(scope:StudyScope,revision?:number)=>createPracticeAssistanceAi(await providerOptions(scope,revision)),
    getCourseAi:async(scope:StudyScope,revision?:number)=>createCourseTaskAi(await providerOptions(scope,revision)),
    fingerprintCourseEvaluation:evaluationFingerprint,
    planAiAvailable:()=>{const config=ports.configuration();return config.enabled&&config.configured;},
    getPlanAi:async(scope:StudyScope,revision?:number)=>createAccountStudyPlanAi(await providerOptions(scope,revision)),
    getQuestionAi:async(scope:StudyScope,revision?:number)=>createAccountStudyQuestionAi(await providerOptions(scope,revision)),
    getChatAi:async(scope:StudyScope,revision?:number)=>createStudyAIChat(await providerOptions(scope,revision)),
    async getAiModels(scope:StudyScope,selection:StudyAIModelSelection,signal?:AbortSignal){
      const store=ports.store(),settings=await store.getSettings(scope);
      if(settings.revision!==selection.expectedRevision)throw Error('ai-settings-stale');
      const supplied=selection.providerKey?.trim();
      if(!supplied&&selection.baseUrl.replace(/\/$/,'')!==settings.providers[selection.provider].baseUrl.replace(/\/$/,''))throw Error('ai-model-list-key-required');
      const key=supplied||await store.providerKey(scope,settings.revision,selection.provider);
      return listProviderModels({provider:selection.provider,baseUrl:selection.baseUrl,key,...(ports.fetcher?{fetcher:ports.fetcher}:{})},signal);
    },
  };
}
