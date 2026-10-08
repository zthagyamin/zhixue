import type { CompanionPlanClient } from '../app/companion-plan-client';

// Compile-time boundary: V2 save cannot advertise a legacy-only snapshot.
export function savedTaskIds(result:Awaited<ReturnType<CompanionPlanClient['applyTaskPlan']>>):string[] {
  return result.revision?.after?.tasks.map(task=>task.taskId) ?? [];
}
