import type {TaskEventV1} from './task-plan-types';
// @ts-expect-error TS5097: Node tests use explicit TypeScript extensions.
import {validPlanDay} from './task-plan-types.ts';
// @ts-expect-error TS5097: Node tests use explicit TypeScript extensions.
import {acceptsRecordedStudyDay} from './study-day.ts';
// @ts-expect-error TS5097: Node tests use explicit TypeScript extensions.
import {planningHash} from './task-plan-engine.ts';

const fields=['schemaVersion','eventType','eventId','coreHash','taskId','subjectId','day','occurredAt','unitIds','source','evidenceRefs'];
const identifier=/^[A-Za-z0-9][A-Za-z0-9._:-]{5,127}$/;
function text(value:unknown):value is string {
  return typeof value==='string' && value.trim().length>0 && value.length<=4000 && ![...value].some(character=>{
    const code=character.codePointAt(0)!;
    return code<32 || code===127 || (code>=0xd800 && code<=0xdfff);
  });
}
function strings(value:unknown):value is string[] {return Array.isArray(value) && value.every(text) && new Set(value).size===value.length;}
export function parseTaskEvent(value:unknown):TaskEventV1 {
  if (!value || typeof value!=='object' || Array.isArray(value)) throw new Error('invalid-task-event');
  const event=value as TaskEventV1;
  if (Object.keys(event).some(key=>!fields.includes(key)) || fields.some(key=>!Object.hasOwn(event,key))) throw new Error('unknown-task-event-field');
  if (event.schemaVersion!==1 || event.eventType!=='task-completed' || typeof event.eventId!=='string' || !identifier.test(event.eventId)
    || !text(event.taskId) || !text(event.subjectId) || !validPlanDay(event.day) || typeof event.coreHash!=='string'
    || !/^[a-f0-9]{64}$/.test(event.coreHash) || !strings(event.unitIds) || !strings(event.evidenceRefs)
    || !['self-report','evidence'].includes(event.source)) throw new Error('invalid-task-event');
  if (typeof event.occurredAt!=='string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(event.occurredAt)
    || !Number.isFinite(Date.parse(event.occurredAt)) || new Date(event.occurredAt).toISOString()!==event.occurredAt
    || !acceptsRecordedStudyDay(event.occurredAt,event.day)) throw new Error('invalid-task-event-day');
  if ((event.source==='self-report' && event.evidenceRefs.length) || (event.source==='evidence' && (!event.evidenceRefs.length || !event.unitIds.length))
    || event.evidenceRefs.some(id=>!identifier.test(id))) throw new Error('invalid-task-evidence');
  return structuredClone(event);
}
export function hashTaskEvent(event:Omit<TaskEventV1,'coreHash'>):Promise<string> {return planningHash(event);}
export async function validateTaskEvent(value:unknown):Promise<TaskEventV1> {
  const event=parseTaskEvent(value),body={...event};
  delete (body as Partial<TaskEventV1>).coreHash;
  if (await hashTaskEvent(body)!==event.coreHash) throw new Error('invalid-task-event-hash');
  return event;
}
