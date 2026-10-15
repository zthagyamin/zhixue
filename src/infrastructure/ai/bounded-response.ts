type ResponseBudget = {
    maxBytes: number;
    maxChars?: number;
    limitError: string;
    signal?: AbortSignal;
};

/** Bound decoded provider bodies before accumulating or parsing their contents. */
export async function readProviderText(response: Response, budget: ResponseBudget): Promise<string> {
    const {maxBytes, maxChars, limitError, signal} = budget;
    if (!response.body) {
        signal?.throwIfAborted();
        return '';
    }
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let text = '', bytes = 0, cancelled = false;
    const cancel = () => {
        if (cancelled) return;
        cancelled = true;
        // Do not let an upstream cancellation acknowledgement retain the reader.
        void reader.cancel().catch(() => {});
    };
    signal?.addEventListener('abort', cancel, {once: true});
    try {
        signal?.throwIfAborted();
        const declared = response.headers.get('Content-Length');
        if (declared !== null && /^(?:0|[1-9]\d*)$/.test(declared)
            && !response.headers.has('Content-Encoding') && Number(declared) > maxBytes) {
            throw new Error(limitError);
        }
        while (true) {
            signal?.throwIfAborted();
            const part = await reader.read();
            signal?.throwIfAborted();
            if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > maxBytes) throw new Error(limitError);
            text += decoder.decode(part.value, {stream: true});
            if (maxChars !== undefined && text.length > maxChars) throw new Error(limitError);
        }
        text += decoder.decode();
        if (maxChars !== undefined && text.length > maxChars) throw new Error(limitError);
        return text;
    } finally {
        signal?.removeEventListener('abort', cancel);
        cancel();
        reader.releaseLock();
    }
}
