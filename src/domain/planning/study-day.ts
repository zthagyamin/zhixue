/** Shanghai study-day policy. Append migrations; never rewrite a prior activation. */
export const STUDY_DAY_START_HOUR=4;
export const STUDY_DAY_POLICY_EFFECTIVE_AT='2026-09-21T20:00:00.000Z';
const FIRST_EXTENDED_DAY='2026-09-22',HOUR=3600000,DAY=24*HOUR;
function instant(iso:string):number{
  const value=Date.parse(iso);if(!Number.isFinite(value))throw Error('invalid-study-time');return value;
}
function dayValue(day:string):number{
  const value=Date.parse(`${day}T00:00:00Z`);
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day)||day.startsWith('0000')||!Number.isFinite(value)||new Date(value).toISOString().slice(0,10)!==day)throw Error('invalid-study-day');
  return value;
}
export function calendarDay(iso:string):string{return new Date(instant(iso)+8*HOUR).toISOString().slice(0,10);}
export function studyDay(iso:string):string{
  const value=instant(iso),offset=value<Date.parse(STUDY_DAY_POLICY_EFFECTIVE_AT)?8:8-STUDY_DAY_START_HOUR;
  return new Date(value+offset*HOUR).toISOString().slice(0,10);
}
export function studyDayBounds(day:string):{start:number;end:number}{
  const value=dayValue(day),next=new Date(value+DAY).toISOString().slice(0,10);
  const start=(label:string,time:number)=>time-8*HOUR+(label>FIRST_EXTENDED_DAY?STUDY_DAY_START_HOUR*HOUR:0);
  return {start:start(day,value),end:start(next,value+DAY)};
}
/** V1 declared days are immutable: old clients used calendar days. New writers use studyDay. */
export function acceptsRecordedStudyDay(iso:string,declaredDay:string):boolean{
  return declaredDay===studyDay(iso)||declaredDay===calendarDay(iso);
}
export function completionDay(value:{occurredAt:string;day?:string}):string{
  if(value.day===undefined)return studyDay(value.occurredAt);
  if(!acceptsRecordedStudyDay(value.occurredAt,value.day))throw Error('invalid-completion-day');
  return value.day;
}
/** Only source-note date encodings, never a general FSRS timestamp normalizer. */
export function sourceReviewDueAt(value:string):string{
  const match=/^(\d{4}-\d{2}-\d{2})T00:00:00\+08:00$/.exec(value);
  if(!match)return value;dayValue(match[1]);
  return match[1]>FIRST_EXTENDED_DAY?`${match[1]}T04:00:00+08:00`:value;
}
