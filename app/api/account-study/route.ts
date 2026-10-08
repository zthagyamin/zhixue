import {createAccountProviderServices} from '../../../src/infrastructure/account-study';
import {env} from 'cloudflare:workers';
import {getChatGPTUser} from '../../chatgpt-auth';
import {createAccountStudyHandlers} from '../../account-study-api';
import {getDatabaseBinding} from '../../../db';
import {AccountStudyAccessStore} from '../../../db/account-study-access-store';
import {AccountStudyStore} from '../../../db/account-study-store';
import {AccountStudyReceiptStore} from '../../../db/account-study-receipt-store';
import {AccountStudyPlanStore} from '../../../db/account-study-plan-store';
import {AccountLongTermPlanStore} from '../../../db/account-long-term-plan-store';
import {AccountStudyAiStore} from '../../../db/account-study-ai-store';
import {AccountStudyContentDecisionStore} from '../../../db/account-study-content-decision-store';
import {AccountAssistanceStore} from '../../../db/account-assistance-store';
import {D1LearningAttemptStore} from '../../../src/infrastructure/learning-attempt';
import {D1CourseEvidenceStore} from '../../../src/infrastructure/course-study';
import {courseEvidenceOriginal} from '../../../src/application/course-study';
import {D1PracticeEvidenceStore} from '../../../src/infrastructure/practice-evidence';
import {D1MathMappingStore} from '../../../src/infrastructure/math-study';

export const dynamic='force-dynamic';
const mathMappings=()=>new D1MathMappingStore(getDatabaseBinding(),new AccountStudyStore(getDatabaseBinding()));
const providers=createAccountProviderServices({
  store:()=>new AccountStudyAiStore(getDatabaseBinding(),(env as Cloudflare.Env&{ACCOUNT_STUDY_AI_ENCRYPTION_KEY?:string}).ACCOUNT_STUDY_AI_ENCRYPTION_KEY??''),
  configuration:()=>{const settings=env as Cloudflare.Env&{ACCOUNT_STUDY_AI_ENABLED?:string;ACCOUNT_STUDY_AI_ENCRYPTION_KEY?:string;ACCOUNT_STUDY_AI_MODEL?:string};
    return{enabled:settings.ACCOUNT_STUDY_AI_ENABLED==='true',configured:Boolean(settings.ACCOUNT_STUDY_AI_ENCRYPTION_KEY),defaultModel:settings.ACCOUNT_STUDY_AI_MODEL??''};},
});
const handlers=createAccountStudyHandlers({
  enabled:()=> (env as Cloudflare.Env&{ACCOUNT_STUDY_ENABLED?:string}).ACCOUNT_STUDY_ENABLED==='true',
  getBrowserUser:getChatGPTUser,
  getAccessStore:async()=>new AccountStudyAccessStore(getDatabaseBinding()),
  getStudyStore:async()=>new AccountStudyStore(getDatabaseBinding()),
  getReceiptStore:async()=>new AccountStudyReceiptStore(getDatabaseBinding()),
  getAssistanceStore:async()=>new AccountAssistanceStore(getDatabaseBinding()),
  getAttemptStore:async()=>new D1LearningAttemptStore(getDatabaseBinding()),
  getMathMappingStore:async()=>mathMappings(),
  getPracticeEvidenceMapping:async()=>mathMappings(),
  getPracticeEvidenceStore:async(service)=>new D1PracticeEvidenceStore(getDatabaseBinding(),courseEvidenceOriginal(new AccountStudyStore(getDatabaseBinding()),new D1LearningAttemptStore(getDatabaseBinding())),{service,mapping:mathMappings()}),
  getCourseEvidenceStore:async()=>new D1CourseEvidenceStore(getDatabaseBinding(),courseEvidenceOriginal(new AccountStudyStore(getDatabaseBinding()),new D1LearningAttemptStore(getDatabaseBinding()))),
  getPlanStore:async()=>new AccountStudyPlanStore(getDatabaseBinding()),
  getLongTermStore:async()=>new AccountLongTermPlanStore(getDatabaseBinding()),
  getAiStore:async()=>new AccountStudyAiStore(getDatabaseBinding(),(env as Cloudflare.Env&{ACCOUNT_STUDY_AI_ENCRYPTION_KEY?:string}).ACCOUNT_STUDY_AI_ENCRYPTION_KEY??''),
  getContentDecisionStore:async()=>new AccountStudyContentDecisionStore(getDatabaseBinding()),
  ...providers,
});
export const GET=handlers.GET;
export const POST=handlers.POST;
