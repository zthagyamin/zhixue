import type {TaskPlanningDependencies} from '../src/application/planning';
// @ts-expect-error TS5097: standalone Node source contracts.
import {createTaskPlanningSession as createSession} from '../src/application/planning/index.ts';
// @ts-expect-error TS5097: standalone Node source contracts.
import {buildDailyPlanningInput,completedPlanTaskIds} from './task-planning-input.ts';
export type {TaskPlanningState,TaskPlanningBundle,TaskPlanConflict} from '../src/application/planning';
/** Legacy projections/storage are injected here; the application owns all draft operations. */
export function createTaskPlanningSession(ports:Omit<TaskPlanningDependencies,'buildInput'|'completedTasks'|'now'|'newId'>&{now?:()=>Date;newId?:()=>string}){
  return createSession({...ports,buildInput:buildDailyPlanningInput,completedTasks:completedPlanTaskIds,now:ports.now??(()=>new Date()),newId:ports.newId??(()=>crypto.randomUUID())});
}
