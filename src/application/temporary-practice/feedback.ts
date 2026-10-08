export type FeedbackReceiptPort = {
    subscribe?: (listener: () => void) => () => void;
    hasSavedFeedback?: () => boolean;
    hasSaveFailure?: () => boolean;
    isPending?: () => boolean;
};
/** Observe the existing save receipt. This use case never writes an event itself. */
export function prepareFeedbackPractice(port: FeedbackReceiptPort, save: () => void | Promise<void>, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    if (port.hasSavedFeedback?.()) return Promise.resolve(true);
    if (!port.subscribe || !port.hasSavedFeedback) return Promise.resolve(false);
    return new Promise(resolve => {
        let finished = false, submitted = false, unsubscribe = () => {};
        const done = (value: boolean) => { if (finished) return; finished = true; unsubscribe(); signal.removeEventListener('abort', cancel); resolve(value); };
        const cancel = () => done(false);
        const check = () => {
            if (signal.aborted) done(false);
            else if (port.hasSavedFeedback?.()) done(true);
            else if (submitted && !port.isPending?.() && port.hasSaveFailure?.()) done(false);
        };
        unsubscribe = port.subscribe!(check);
        signal.addEventListener('abort', cancel, {once: true});
        try {
            Promise.resolve(save()).then(()=>{submitted=true;check();if(!finished&&!port.isPending?.())done(false);},()=>done(false));
            check();
        } catch { done(false); }
    });
}
