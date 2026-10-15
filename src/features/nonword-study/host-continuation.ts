import type {FSRSRating} from '../../domain/assessment';
import type {HostDriver} from './host-contracts';
import type {NonWordLearningPort} from '../../application/nonword-study';

type Ports = {
    locked: () => boolean;
    current: () => boolean;
    live: () => boolean;
    temporary?: boolean;
    lock: (value: boolean) => void;
    busy: (value: boolean) => void;
    retry: (value: boolean) => void;
    error: (message: string) => void;
    flush: () => Promise<unknown>;
    consumeDraft: () => boolean | undefined;
    resume: (rating: FSRSRating) => void;
};
/** A failed continuation keeps its saved grade and offers the same logical retry. */
export async function continueHostFormal(parent: HostDriver, ports: Ports) {
    if (ports.locked() || !ports.current()) return;
    ports.lock(true); ports.busy(true); ports.retry(false);
    try {
        await ports.flush();
        const attempt = parent.runtime.session.snapshot();
        if (!ports.temporary) {
            if (attempt?.formal?.status !== 'linked') throw Error('正式结果尚未可靠保存。');
            await parent.runtime.session.markTraversed();
            await parent.runtime.afterWrite();
        } else if (parent.group) {
            await parent.runtime.session.markAuxiliaryTraversed();
            await parent.runtime.afterWrite();
        }
        const rating = attempt?.formal?.rating ?? (attempt?.evaluation.status === 'resolved' ? attempt.evaluation.rating : null);
        if (!rating) throw Error('本次作答仍待核对，请从待核对入口继续。');
        await parent.continueGroup?.(rating);
        if (ports.current() && !ports.consumeDraft()) ports.resume(rating);
    } catch (reason) {
        ports.lock(false); ports.retry(true);
        ports.error(reason instanceof Error ? reason.message : '续学状态尚未保存，请再试一次。');
    } finally {
        if (ports.live()) ports.busy(false);
    }
}

type PendingPorts={current:()=>boolean;live:()=>boolean;locked:()=>boolean;lock:(value:boolean)=>void;
    busy:(value:boolean)=>void;error:(message:string)=>void;guided:()=>boolean};
export function continueHostPending(lifecycle:NonWordLearningPort,ports:PendingPorts){
    if(ports.locked()||!ports.current())return;
    ports.lock(true);ports.busy(true);ports.error('');
    void lifecycle.continuePending().then(()=>{if(ports.guided())ports.lock(false);})
        .catch(error=>{ports.lock(false);if(ports.current())ports.error(error instanceof Error?error.message:'继续状态尚未保存，请重试。');})
        .finally(()=>{if(ports.live())ports.busy(false);});
}
export async function persistHostPending(driver:HostDriver){
    await driver.source?.beforeContinue?.();
    await driver.runtime.session.traversePending();
    await driver.runtime.afterWrite();
}
type StoredPendingPorts={current:()=>HostDriver|null;valid:()=>boolean;flush:()=>Promise<void>;
    status:(message:string)=>void;advance:()=>void};
export async function continueStoredHostPending(ports:StoredPendingPorts){
    const current=ports.current();
    const check=()=>{if(!ports.valid()||ports.current()!==current)throw Error('来源或账号已切换，本次操作已停止。');};
    check();if(!current)throw Error('答案尚未可靠保存。');
    await ports.flush();check();await persistHostPending(current);check();
    if(current.runtime.purpose==='guided'){
        ports.status('引导答案已保存，等待核对；可以收起讲解进入独立尝试。');return;
    }
    await current.continueGroup?.('pending');if(ports.valid())ports.advance();
}
