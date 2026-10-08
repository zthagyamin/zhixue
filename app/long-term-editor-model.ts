// @ts-expect-error TS5097: standalone Node source contracts.
import {generateLongTermSchedule,rebalanceScheduleOnDelta} from './long-term-pacing.ts';
// @ts-expect-error TS5097: standalone Node source contracts.
import {createLongTermPreview} from '../src/domain/planning/index.ts';
// @ts-expect-error TS5097: standalone Node source contracts.
export {defaultLongTermSpec} from '../src/domain/planning/index.ts';
export type {LongTermEditorSource,LongTermEditorSubject} from '../src/domain/planning';
export const previewLongTermPlan=createLongTermPreview({generateLongTermSchedule,rebalanceScheduleOnDelta});
export function longTermMessage(error:unknown):string{
  const code=error instanceof Error?error.message:'';
  if(code==='long-term-start-tomorrow')return'新目标从明天开始，今天的学习安排保持稳定。';
  if(code==='long-term-deadline-future')return'截止日期需要晚于今天。';
  if(code==='long-term-original-start')return'已有目标的起始日期保留；可以调整未来节奏与截止日期。';
  if(code==='long-term-source-changed')return'学习资料或进度刚刚变化，请重新预览后保存。';
  if(code==='long-term-stale')return'计划已在其他页面或设备更新，已读取最新版本，请重新预览。';
  if(code.startsWith('invalid-long-term'))return'请检查日期、学习时长与学科配额。';
  if(code==='invalid-practice-budget-groups')return'请检查共享预算：每组至少一个学科且不能重复，预算为 0–180 整数分钟，默认估时为 1–30 整数分钟。';
  if(code==='long-term-planning-unavailable'||code==='study-service-unavailable')return'长线计划暂时无法连接，请稍后重试。';
  return code.includes('数据库')?code:'暂未完成，请检查连接后重试；已保存的计划保留。';
}
