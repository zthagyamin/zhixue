export type PracticeSummary = { answered: number; correct: number; wrong: number };
export type PracticeEndReason = 'exhausted' | 'stopped' | 'empty' | 'recovery-error' | 'load-error';
/** Page result only. It is never a formal task-completion or delivery receipt. */
export type PracticeSessionResult = PracticeSummary & {
  reason: PracticeEndReason;
  awaitingReview?: number;
  skipped?: number;
  remaining?: number;
};

export function practiceSessionResult(
  summary: PracticeSummary,
  reason: PracticeEndReason,
  counts: Pick<PracticeSessionResult, 'awaitingReview' | 'skipped' | 'remaining'> = {},
): PracticeSessionResult {
  return { ...summary, reason, ...counts };
}

export function practiceResultView(result: PracticeSessionResult) {
  const titles: Record<PracticeEndReason, string> = {
    exhausted: '本轮练习结束', stopped: '已提前结束', empty: '当前暂无复习题',
    'recovery-error': '题组恢复未完成', 'load-error': '复习题读取未完成',
  };
  return {
    title: titles[result.reason],
    detail: result.reason === 'recovery-error' || result.reason === 'load-error'
      ? '已有作答保留；当前范围尚未完整核对，请重新读取。'
      : result.reason === 'empty'
        ? '当前练习范围没有可练项目，可以返回今日或选择学科自由学习。'
        : '本轮结束不代表全部答对或任务已完成；后续安排仍以实际学习记录为准。',
  };
}
