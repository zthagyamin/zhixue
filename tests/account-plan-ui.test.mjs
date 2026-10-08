import assert from 'node:assert/strict';
import test from 'node:test';

import {
  accountPlanInitialUiState,
  accountPlanSummary,
  reduceAccountPlanUi,
  resolveLegacyPlanningVisibility,
  shouldUseCaughtUpPage,
} from '../app/account-plan-ui.ts';

test('account plan starts collapsed and opens one purpose-built view at a time', () => {
  assert.deepEqual(accountPlanInitialUiState, { expanded: false, view: 'execute' });

  const opened = reduceAccountPlanUi(accountPlanInitialUiState, { type: 'toggle' });
  assert.deepEqual(opened, { expanded: true, view: 'execute' });

  const editing = reduceAccountPlanUi(opened, { type: 'show-editor' });
  assert.deepEqual(editing, { expanded: true, view: 'edit' });

  const closed = reduceAccountPlanUi(editing, { type: 'close' });
  assert.deepEqual(closed, { expanded: false, view: 'execute' });
});

test('account plan summary keeps execution progress ahead of draft metadata', () => {
  assert.deepEqual(accountPlanSummary({ revision: 3, approvedCount: 12, completedCount: 1, draftCount: 13 }), {
    progress: '已批准 12 项 · 已完成 1 项',
    metadata: 'revision 3 · 草稿 13 项',
  });
});

test('account mode hides the duplicate legacy plan warning and local constraint editor', () => {
  assert.deepEqual(resolveLegacyPlanningVisibility({
    accountMode: true,
    taskPlanningEnabled: false,
    companionConnected: true,
    indexed: true,
  }), { warning: false, constraints: false });

  assert.deepEqual(resolveLegacyPlanningVisibility({
    accountMode: false,
    taskPlanningEnabled: false,
    companionConnected: true,
    indexed: true,
  }), { warning: true, constraints: true });
});

test('account mode keeps its compact plan reachable even when modules are caught up', () => {
  assert.equal(shouldUseCaughtUpPage({ accountMode: true, isCaughtUp: true, hasEffectivePlan: false, taskPlanningEnabled: false }), false);
  assert.equal(shouldUseCaughtUpPage({ accountMode: false, isCaughtUp: true, hasEffectivePlan: false, taskPlanningEnabled: false }), true);
});
