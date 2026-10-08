import type {TemporaryDraft} from './draft';
export type TemporaryResult = {kind: string; message: string; details?: string; assertionsPassed?: number};
export type TemporaryRunPort = {
    run: (input: Record<string, string>, signal: AbortSignal) => Promise<TemporaryResult>;
    cancel?: () => void;
};

/** Bounded async lifecycle. A cancelled/old result cannot update a new item or write a grade. */
export function createTemporaryRun(draft: TemporaryDraft, port: TemporaryRunPort) {
    let epoch = 0, controller: AbortController | null = null, disposed = false;
    let state: {phase: 'ready' | 'running' | 'complete' | 'failed' | 'cancelled'; result: TemporaryResult | null} = {phase: 'ready', result: null};
    let revision=0;const listeners=new Set<()=>void>();
    const notify=()=>{revision++;for(const listener of [...listeners])listener();};
    return {
        snapshot: () => state,
        subscribe(listener:()=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},
        getSnapshot:()=>revision,
        clearResult(){if(controller||disposed)return;state={phase:'ready',result:null};notify();},
        async start() {
            if (disposed || !draft.isActive() || controller) return;
            const request = ++epoch, active = new AbortController(); controller = active;
            state = {phase: 'running', result: null}; draft.setBusy(true);notify();
            try {
                const result = await port.run(draft.values(), active.signal);
                if (disposed || !draft.isActive() || request !== epoch || active.signal.aborted) return;
                state = {phase: 'complete', result};notify();
            } catch (error) {
                if (disposed || !draft.isActive() || request !== epoch || active.signal.aborted) return;
                state = {phase: 'failed', result: {kind: 'unknown', message: '本次补练未能核对，输入仍保留。', details: error instanceof Error ? error.message : String(error)}};
                notify();
            } finally {
                if (request === epoch) { controller = null; draft.setBusy(false); }
            }
        },
        cancel() {
            epoch++; if(controller){controller.abort();port.cancel?.();} controller = null;
            state = {phase: 'cancelled', result: null}; draft.setBusy(false);notify();
        },
        dispose() {
            if (disposed) return;
            disposed = true; epoch++; if(controller){controller.abort();port.cancel?.();} controller = null; draft.setBusy(false);
        },
    };
}
