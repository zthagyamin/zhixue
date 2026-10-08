export type AccountPlanUiState = {
  expanded: boolean;
  view: 'execute' | 'edit';
};

export type AccountPlanUiAction =
  | { type: 'toggle' }
  | { type: 'show-execution' }
  | { type: 'show-editor' }
  | { type: 'close' };

export const accountPlanInitialUiState: AccountPlanUiState = {
  expanded: false,
  view: 'execute',
};

export function reduceAccountPlanUi(state: AccountPlanUiState, action: AccountPlanUiAction): AccountPlanUiState {
  if (action.type === 'close') return accountPlanInitialUiState;
  if (action.type === 'show-execution') return { expanded: true, view: 'execute' };
  if (action.type === 'show-editor') return { expanded: true, view: 'edit' };
  return state.expanded ? accountPlanInitialUiState : { expanded: true, view: 'execute' };
}

export function accountPlanSummary(input: {
  revision: number;
  approvedCount: number;
  completedCount: number;
  draftCount: number;
}) {
  return {
    progress: `已批准 ${input.approvedCount} 项 · 已完成 ${input.completedCount} 项`,
    metadata: `revision ${input.revision} · 草稿 ${input.draftCount} 项`,
  };
}

export function resolveLegacyPlanningVisibility(input: {
  accountMode: boolean;
  taskPlanningEnabled: boolean;
  companionConnected: boolean;
  indexed: boolean;
}) {
  const constraints = !input.accountMode && !input.taskPlanningEnabled;
  return {
    warning: constraints && input.companionConnected && input.indexed,
    constraints,
  };
}

export function shouldUseCaughtUpPage(input: {
  accountMode: boolean;
  isCaughtUp: boolean;
  hasEffectivePlan: boolean;
  taskPlanningEnabled: boolean;
}) {
  return !input.accountMode && input.isCaughtUp && !input.hasEffectivePlan && !input.taskPlanningEnabled;
}
