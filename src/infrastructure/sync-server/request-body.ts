export class SyncBodyLimitError extends Error {}

/** Keep the original UTF-16 limit while bounding actual UTF-8 input bytes. */
export async function readSyncRequestBody(request: Request): Promise<string> {
    request.signal.throwIfAborted();
    if (!request.body) return '';
    const reader = request.body.getReader(), decoder = new TextDecoder();
    let text = '', bytes = 0, cancelled = false;
    const cancel = () => {
        if (cancelled) return;
        cancelled = true;
        void reader.cancel().catch(() => {});
    };
    request.signal.addEventListener('abort', cancel, {once: true});
    try {
        request.signal.throwIfAborted();
        while (true) {
            const part = await reader.read();
            request.signal.throwIfAborted();
            if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > 256000) throw new SyncBodyLimitError();
            text += decoder.decode(part.value, {stream: true});
            if (text.length > 64000) throw new SyncBodyLimitError();
        }
        text += decoder.decode();
        if (text.length > 64000) throw new SyncBodyLimitError();
        return text;
    } finally {
        request.signal.removeEventListener('abort', cancel);
        cancel();
        reader.releaseLock();
    }
}
