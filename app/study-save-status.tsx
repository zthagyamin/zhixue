import {auxiliaryDeliveryLabel} from './study-submission-status';
import {saveStatusPresentation} from './study-save-status-model';
import './study-guidance.css';
type State = Parameters<typeof auxiliaryDeliveryLabel>[0];
/** Core save is already confirmed by the caller. Auxiliary receipts are not core sync receipts. */
export function StudySaveStatus({state}: {state: State}) {
  const status = saveStatusPresentation(state);
  return <div className="study-save-status" data-attention={status.attention || undefined}>
    {status.attention && <p role="status">{status.label}</p>}
    <details aria-label="辅助摘要同步状态"><summary>{status.attention ? '查看保存详情' : status.label}</summary>
      <p>最近一次提交已存本机。{auxiliaryDeliveryLabel(state)}</p>
      <p>这里的摘要状态不代表所有设备都已收到正式作答；完整记录可在“同步与记录”中核对。</p>
    </details>
  </div>;
}
