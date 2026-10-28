export type WordStudyPresentationInput = Readonly<{
  vocabulary?: boolean;
  demo: boolean;
  planned: boolean;
  review: boolean;
  groupIndex: number;
  groupCount: number;
  total: number;
  completed: number;
  ready: boolean;
  practiced: boolean;
  stage: number;
  quickReview: boolean;
  threeStage: boolean;
  modeLabel: string;
}>;

/** Describe the supplied projection without deriving grades, stages or mastery. */
export function wordStudyPresentation(input: WordStudyPresentationInput): {
  scope: string;
  progress: string;
  mode: string;
} {
  const vocabulary = input.vocabulary !== false;
  const scope = input.demo
    ? '公开示例 · 不计入个人记录'
    : input.planned
      ? `${input.review ? '到期复习' : '今日任务'} · 本组 ${input.total} ${vocabulary ? '词' : '题'}`
      : vocabulary ? `自由学习 · 词库第 ${input.groupIndex + 1} / ${input.groupCount} 组` : '自由学习';
  const verifiedCount = input.ready
    && Number.isInteger(input.completed) && input.completed >= 0
    && Number.isInteger(input.total) && input.total > 0 && input.completed <= input.total;
  const progress = verifiedCount
    ? `${vocabulary ? `本组${input.practiced ? '已练' : '完成'}` : input.practiced ? '已练' : '已完成'} ${input.completed} / ${input.total}${vocabulary ? ' 词' : ''}`
    : '进度待核对';
  const step = ['认义', '语境', '闭卷自评'][input.stage - 1];
  const mode = !input.threeStage ? input.modeLabel
    : input.quickReview ? '到期复习 · 回忆核对'
      : step ? `当前步骤：${step}` : '学习步骤待核对';
  return {scope, progress, mode};
}

/** A completed quick review does not prove that three separate stages occurred. */
export function wordQueueStatus(completedStage: number, ready: boolean): string {
  if (!ready || !Number.isInteger(completedStage) || completedStage < 0 || completedStage > 3)
    return '进度待核对';
  return ['未完成', '待语境核对', '待闭卷自评', '本组已完成'][completedStage];
}
