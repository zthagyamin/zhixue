import {withStudyEventCoreHash,SCHEDULER_VERSION} from '../../app/study-event-v3.ts';

export const DAY='2026-08-31';
export function word(overrides={}) {
  return {itemKey:'word:tree',subjectId:'vocab',word:'Tree',language:'en',
    sourceHash:'a'.repeat(64),completionRule:'three-stage',...overrides};
}
export async function attempt(id,at,before,after,correct=true,overrides={}) {
  const when=new Date(at).toISOString();
  const scheduled=!correct || after===3;
  return withStudyEventCoreHash({schemaVersion:3,eventId:id,coreHash:'',occurredAt:when,
    domain:'ielts',eventType:'practice-attempt',item:{kind:'word',key:'word:tree'},
    attempt:{rating:correct?'good':'again',correct,stageBefore:before,stageAfter:after},
    ...(scheduled ? {scheduling:{reviewedAt:when,schedulerVersion:SCHEDULER_VERSION}} : {}),...overrides});
}
export async function baseline(key='word:tree',due='2026-08-31T00:00:00.000Z') {
  return withStudyEventCoreHash({schemaVersion:3,eventId:`baseline-${key}`,coreHash:'',
    occurredAt:'2026-08-31T01:00:00.000Z',domain:'ielts',eventType:'review-baseline',
    item:{kind:'word',key},schedulerVersion:SCHEDULER_VERSION,
    baselineState:{due,stability:'20',difficulty:'5',elapsedDays:30,scheduledDays:30,
      learningSteps:0,reps:5,lapses:0,state:2,lastReview:'2026-08-01T00:00:00.000Z'}});
}
export function catalog(words=[word()]) {
  return {schemaVersion:1,sourceHash:'a'.repeat(64),diagnostics:[],subjects:[{
    subjectId:'vocab',name:'Words',priority:3,words,units:[],goals:[],planningStatus:'none',
  }]};
}
