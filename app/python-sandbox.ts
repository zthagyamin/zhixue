// @ts-expect-error TS5097: standalone Node contracts.
import { normalizeCodeRunReport } from '../src/domain/code-execution/index.ts';
/** Untrusted Python never executes in the application's origin.
 * The opaque frame/worker and its CSP are the boundary, not Python blacklists.
 * The host only serves immutable runtime assets from a trusted lockfile.
 */
const VERSION = '314.0.5';
const LOCAL_ROOT = `/vendor/pyodide-${VERSION}/`;
const PACKAGE_ROOT = `https://cdn.jsdelivr.net/pyodide/v${VERSION}/full/`;
const MAX_ASSET_BYTES = 48 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;
type Asset = {
    file_name: string;
    sha256: string;
};
type Lockfile = {
    packages: Record<string, Asset>;
};
type SandboxPort = {
    postMessage(value: unknown): void;
    terminate(): void;
    onmessage: ((event: MessageEvent) => void) | null;
    onerror: ((event: ErrorEvent) => void) | null;
};
export function isRuntimeAssetName(name: unknown): name is string {
    return typeof name === 'string' && /^[A-Za-z0-9_][A-Za-z0-9_.+-]*\.whl$/.test(name) && name.length <= 240;
}
/** Exact filenames only: no arbitrary URL, query, redirect, request body or headers. */
export function runtimeAssetURL(name: unknown, assets: ReadonlyMap<string, Asset>): string | null {
    return isRuntimeAssetName(name) && assets.has(name) ? PACKAGE_ROOT + name : null;
}
export function createPythonSandboxWorker(): SandboxPort {
    let stopped = false;
    let channel: MessageChannel | null = null;
    let frame: HTMLIFrameElement | null = null;
    let connected = false;
    let totalBytes = 0;
    let requests = 0;
    const abort = new AbortController();
    const queued: unknown[] = [];
    const packageCache = new Map<string, Promise<ArrayBuffer>>();
    const assets = new Map<string, Asset>();
    const api: SandboxPort = {
        onmessage: null,
        onerror: null,
        postMessage(value) {
            if (stopped)
                throw new Error('运行环境已关闭。');
            if (connected)
                channel!.port1.postMessage(value);
            else if (queued.length < 4)
                queued.push(value);
            else
                throw new Error('运行环境尚未就绪。');
        },
        terminate() {
            if (stopped)
                return;
            stopped = true;
            abort.abort();
            channel?.port1.postMessage({
                type: 'dispose'
            });
            channel?.port1.close();
            frame?.remove();
            frame = null;
            queued.length = 0;
            packageCache.clear();
        },
    };
    function fail() {
        if (stopped)
            return;
        api.onmessage?.(new MessageEvent('message', {
            data: {
                type: 'load-error', error: '隔离运行环境加载失败。请重新加载；不会退回主站同源执行。'
            }
        }));
        api.terminate();
    }
    async function readAsset(url: string, expectedHash?: string): Promise<ArrayBuffer> {
        const response = await fetch(url, {
            credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: abort.signal
        });
        if (!response.ok || !response.body)
            throw new Error('runtime-asset-unavailable');
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done)
                    break;
                size += value.byteLength;
                totalBytes += value.byteLength;
                if (size > MAX_ASSET_BYTES || totalBytes > MAX_TOTAL_BYTES)
                    throw new Error('runtime-asset-too-large');
                chunks.push(value);
            }
        }
        catch (error) {
            await reader.cancel();
            throw error;
        }
        const data = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
            data.set(chunk, offset);
            offset += chunk.byteLength;
        }
        if (expectedHash) {
            const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
            const hex = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
            if (hex !== expectedHash.toLowerCase())
                throw new Error('runtime-asset-integrity');
        }
        return data.buffer;
    }
    async function answerAsset(data: {
        id: number;
        file: string;
    }) {
        const url = runtimeAssetURL(data.file, assets);
        // This counter also bounds denied requests; messages never become general fetches.
        if (++requests > 128) {
            fail();
            return;
        }
        if (!Number.isSafeInteger(data.id) || !url) {
            channel?.port1.postMessage({
                type: 'asset-response', id: data.id, error: 'runtime-asset-denied'
            });
            return;
        }
        try {
            if (!packageCache.has(data.file)) {
                if (packageCache.size >= 32)
                    throw new Error('runtime-package-limit');
                packageCache.set(data.file, readAsset(url, assets.get(data.file)!.sha256));
            }
            const bytes = (await packageCache.get(data.file)!).slice(0);
            if (!stopped)
                channel?.port1.postMessage({
                    type: 'asset-response', id: data.id, bytes
                }, [bytes]);
        }
        catch {
            if (!stopped)
                channel?.port1.postMessage({
                    type: 'asset-response', id: data.id, error: 'runtime-asset-unavailable'
                });
        }
    }
    void (async () => {
        const names = ['pyodide.mjs', 'pyodide.asm.mjs', 'pyodide.asm.wasm', 'python_stdlib.zip', 'pyodide-lock.json'];
        const [html, runtime, checker, ...files] = await Promise.all([
            readAsset('/workers/python-sandbox-frame.html'),
            readAsset('/workers/python-runtime.js'),
            readAsset('/workers/python-assertions.py'),
            ...names.map(name => readAsset(LOCAL_ROOT + name)),
        ]);
        if (stopped)
            return;
        const decode = (bytes: ArrayBuffer) => new TextDecoder().decode(bytes);
        const lockfile = JSON.parse(decode(files[4])) as Lockfile;
        if (!lockfile.packages || typeof lockfile.packages !== 'object')
            throw new Error('invalid-runtime-lockfile');
        for (const entry of Object.values(lockfile.packages)) {
            if (isRuntimeAssetName(entry.file_name) && /^[a-f0-9]{64}$/i.test(entry.sha256))
                assets.set(entry.file_name, entry);
        }
        frame = document.createElement('iframe');
        frame.hidden = true;
        frame.title = '隔离的 Python 运行环境';
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.setAttribute('aria-hidden', 'true');
        frame.referrerPolicy = 'no-referrer';
        channel = new MessageChannel();
        channel.port1.onmessage = event => {
            if (stopped)
                return;
            const data = event.data;
            if (!data || typeof data !== 'object')
                return;
            if (data.type === 'sandbox-connected' && !connected) {
                connected = true;
                for (const message of queued.splice(0))
                    channel!.port1.postMessage(message);
            }
            else if (data.type === 'asset-request') {
                void answerAsset(data);
            }
            else if (['ready', 'load-error', 'running', 'result', 'error', 'prepare-error'].includes(data.type)) {
                // A closed report is normalized here and again in the client; all other worker fields are dropped.
                const report = normalizeCodeRunReport(data.report);
                const safe = {
                    type: data.type, report: data.report === undefined ? undefined : report ?? null, id: Number.isSafeInteger(data.id) ? data.id : undefined,
                    output: typeof data.output === 'string' ? data.output.slice(0, 20000) : '',
                    result: typeof data.result === 'string' ? data.result.slice(0, 20000) : null,
                    error: typeof data.error === 'string' ? data.error.slice(0, 20000) : undefined,
                    executionPhase: ['preparation', 'test-definition', 'program', 'tests'].includes(data.executionPhase) ? data.executionPhase : undefined,
                    assertionFailure: data.assertionFailure === true,
                    testDefinitionError: data.testDefinitionError === true,
                    assertionsPassed: Number.isSafeInteger(data.assertionsPassed) && data.assertionsPassed > 0 ? data.assertionsPassed : undefined
                };
                api.onmessage?.(new MessageEvent('message', {
                    data: safe
                }));
            }
        };
        frame.addEventListener('load', () => {
            if (stopped || !frame?.contentWindow || !channel)
                return;
            frame.contentWindow.postMessage({
                type: 'sandbox-bootstrap', runtime: decode(runtime), checker: decode(checker),
                loader: decode(files[0]), assembly: decode(files[1]), wasm: files[2], stdlib: files[3], lockfile
            }, '*', [channel.port2, files[2], files[3]]);
        }, {
            once: true
        });
        // Only the shipped bridge is HTML. Learner/test code is always structured-cloned.
        frame.srcdoc = decode(html);
        document.body.appendChild(frame);
    })().catch(fail);
    return api;
}
