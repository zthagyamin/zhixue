'use client';
import type {PaperReadingClockState, PaperReadingGroupClockState} from '../../application/paper-reading-clock';

export type PaperReadingClockControlsProps = {
    state: PaperReadingClockState | PaperReadingGroupClockState;
    onPause: (paused: boolean) => void;
    onRetry?: () => void;
    showElapsed?: boolean;
};
function effectiveTime(elapsedMs: number) {
    const seconds = Math.floor(elapsedMs / 1000);
    return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
export function PaperReadingClockControls({state, onPause, onRetry, showElapsed = false}: PaperReadingClockControlsProps) {
    const groupState = 'groupId' in state ? state : null;
    return <div className="paper-reading-unit-controls" aria-label="阅读暂停">
        <button type="button" disabled={state.status !== 'ready' || groupState?.groupCompleted}
            onClick={() => onPause(!state.paused)}>{groupState?.groupCompleted ? '本组已结束' : state.paused ? '继续阅读' : '暂停阅读'}</button>
        {state.paused && <span role="status">阅读已暂停</span>}
        {showElapsed && state.status === 'ready' && <span>{groupState ? '本组有效用时' : '本材料累计有效用时'} {effectiveTime(state.elapsedMs)}</span>}
        {state.saveStatus === 'failed' || state.status === 'unavailable' ? <div role="alert">
            <span>{state.status === 'unavailable' ? '阅读计时无法恢复；旧计时保留。' : '阅读计时尚未保存。'}原答案不受影响。</span>
            {onRetry && <button type="button" onClick={onRetry}>{state.status === 'unavailable' ? '重试恢复计时' : '重试保存计时'}</button>}
        </div> : null}
    </div>;
}

/** Place in the existing “更多工具”; the target does not interrupt reading. */
export function PaperReadingClockDetails({state, onStartGroup}: {state: PaperReadingClockState | PaperReadingGroupClockState; onStartGroup?: () => void}) {
    const groupState = 'groupId' in state ? state : null;
    return <section aria-label="阅读用时">
        <p>10—15 分钟是软目标，可按需要继续或暂停。</p>
        {state.status === 'ready' && <>
            {groupState && <p>本组有效用时 {effectiveTime(state.elapsedMs)}{groupState.groupCompleted ? ' · 本组已结束' : ''}</p>}
            <p>本材料累计有效用时 {effectiveTime(groupState?.materialElapsedMs ?? state.elapsedMs)}</p>
        </>}
        {groupState && onStartGroup && <button type="button" disabled={state.status !== 'ready' || state.saveStatus === 'saving' || state.saveStatus === 'failed'}
            onClick={onStartGroup}>开始新组</button>}
        {groupState && <p>新组从零计时，上一组和材料累计记录保留。达到软目标不会自动结束本组。</p>}
        <p>只记录当前阅读页可见且处于阅读状态的时间；暂停、隐藏和离开不计入。</p>
        <p>计时仅保存在本机，尚未同步到其他设备。实际阅读耗时待校准，计时不代表理解或掌握。</p>
    </section>;
}
