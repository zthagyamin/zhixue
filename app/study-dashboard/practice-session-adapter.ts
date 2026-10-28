import {accountStudyPayload} from '../account-study-payload';
import type {PracticeSessionResult} from '../../src/features/review-session';
import type {DashboardController} from './use-dashboard-controller';
export {inlineNonWordScope,inlinePracticeGroup} from './nonword-scopes';

/** Close only the page session; existing record and deferred-source handling stays intact. */
export function finishDashboardPractice(model:Pick<DashboardController,
  'accountAttemptActiveRef'|'accountLoadedRef'|'accountPendingLoadedRef'|'pendingLocalSourceRef'|
  'setPracticeItems'|'setPracticeSummary'|'applyAccountLoaded'|'setData'|'applyLocalStudySource'|
  'workspaceId'|'noteEventsChanged'>,result:PracticeSessionResult){
  const wasNativeActive=model.accountAttemptActiveRef.current&&!model.accountLoadedRef.current;
  model.setPracticeItems(null);
  model.setPracticeSummary(result.reason==='empty'?null:result);
  model.accountAttemptActiveRef.current=false;
  const pending=model.accountPendingLoadedRef.current;
  if(pending)void model.applyAccountLoaded(pending);
  else {
    const account=model.accountLoadedRef.current;
    if(account)model.setData(accountStudyPayload(account,model.workspaceId) as unknown as DashboardController['data']);
    else if(model.pendingLocalSourceRef.current?.workspaceId===model.workspaceId)
      model.applyLocalStudySource(model.pendingLocalSourceRef.current.payload,model.workspaceId);
  }
  if(wasNativeActive)model.noteEventsChanged();
}
