/** A page-local drill. This module deliberately has no persistence or transport dependencies. */
export type ExtraPracticeRating = 'again' | 'hard' | 'good' | 'easy';
export type ExtraPracticeState = {
  stages: number[];
  index: number;
  revision: number;
  complete: boolean;
  reviewed?: number[];
  skipped?: number[];
};

export function createExtraPracticeState(count: number): ExtraPracticeState {
  if (!Number.isSafeInteger(count) || count < 1) throw new Error('extra-practice-empty');
  return { stages: Array<number>(count).fill(0), index: 0, revision: 0, complete: false };
}

/** Ignore double clicks and late callbacks from a card that has already been replaced. */
export function advanceExtraPractice(
  state: ExtraPracticeState,
  attempt: { index: number; revision: number; threeStage: boolean; rating: ExtraPracticeRating; recall?: boolean },
): ExtraPracticeState {
  if (state.complete || attempt.index !== state.index || attempt.revision !== state.revision) return state;
  if (!['again', 'hard', 'good', 'easy'].includes(attempt.rating)) return state;
  const stages = [...state.stages];
  const correct = attempt.rating === 'good' || attempt.rating === 'easy';
  stages[state.index] = correct ? (attempt.threeStage ? Math.min(3, stages[state.index] + 1) : 3) : 0;
  const reviewed=attempt.recall?[...new Set([...(state.reviewed??[]),state.index])]:state.reviewed;
  const skipped=attempt.recall?(state.skipped??[]).filter(index=>index!==state.index):state.skipped;
  const visited=(index:number)=>stages[index]>=3||Boolean(reviewed?.includes(index)||skipped?.includes(index));
  const complete = stages.every((_,index) => visited(index));
  let index = state.index;
  if (!complete) {
    for (let step = 1; step <= stages.length; step++) {
      const candidate = (state.index + step) % stages.length;
      if (!visited(candidate)) { index = candidate; break; }
    }
  }
  return { stages, index, complete, revision: state.revision + 1, ...(reviewed?{reviewed}:{}), ...(skipped?{skipped}:{}) };
}

export function skipExtraPractice(state:ExtraPracticeState,index:number,revision:number):ExtraPracticeState{
  if(state.complete||index!==state.index||revision!==state.revision)return state;
  const skipped=[...new Set([...(state.skipped??[]),index])];
  const visited=(i:number)=>state.stages[i]>=3||Boolean(state.reviewed?.includes(i)||skipped.includes(i));
  const complete=state.stages.every((_,i)=>visited(i));let next=index;
  for(let step=1;step<=state.stages.length;step++){const candidate=(index+step)%state.stages.length;if(!visited(candidate)){next=candidate;break;}}
  return {...state,skipped,index:next,complete,revision:state.revision+1};
}
