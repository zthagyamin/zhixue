type ThreeStageTransitionInput = {
  currentIndex: number;
  stages: readonly number[];
  correct: boolean;
  random?: () => number;
};

export type ThreeStageTransition = {
  stages: number[];
  nextIndex: number;
  complete: boolean;
};

export function advanceThreeStageSession({
  currentIndex,
  stages,
  correct,
  random = Math.random,
}: ThreeStageTransitionInput): ThreeStageTransition {
  const nextStages = stages.map((stage, index) => {
    if (index !== currentIndex) return stage;
    return correct ? Math.min(3, stage + 1) : 0;
  });

  const incomplete = nextStages
    .map((stage, index) => ({ stage, index }))
    .filter(({ stage }) => stage < 3)
    .map(({ index }) => index);
  const alternatives = incomplete.filter((index) => index !== currentIndex);
  const candidates = alternatives.length > 0 ? alternatives : incomplete;

  if (candidates.length === 0) {
    return { stages: nextStages, nextIndex: currentIndex, complete: true };
  }

  const randomValue = Math.min(Math.max(random(), 0), 1 - Number.EPSILON);
  return {
    stages: nextStages,
    nextIndex: candidates[Math.floor(randomValue * candidates.length)],
    complete: false,
  };
}
