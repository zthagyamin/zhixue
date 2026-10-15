// @ts-expect-error TS5097: standalone Node contracts.
import { normalizeCodeRunReport, parseCodeRunOptions, scientificRuntimeRequirement } from '../src/domain/code-execution/index.ts';
import type { CodeRunOptions, CodeRunReportV1 } from '../src/domain/code-execution/index.ts';
export type PythonRunResult = {
    output: string;
    result?: unknown;
    assertionsPassed?: number;
    report?: CodeRunReportV1;
};
type WorkerPort = {
    postMessage: (value: unknown) => void;
    terminate: () => void;
    onmessage: ((event: MessageEvent) => void) | null;
    onerror: ((event: ErrorEvent) => void) | null;
};
type Pending = {
    id: number;
    started: boolean;
    options: CodeRunOptions;
    originalLineCount: number;
    resolve: (value: PythonRunResult) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
};
function failure(message: string, name = 'Error') {
    const error = new Error(message);
    error.name = name;
    return error;
}
function acceptedReport(data: Record<string, unknown>, run: Pending) {
    const report = normalizeCodeRunReport(data.report);
    if (!report || report.runId !== run.id || report.mapping.originalLineCount !== run.originalLineCount || (data.type === 'result') !== (report.status === 'passed') || JSON.stringify(report.identity) !== JSON.stringify(run.options.identity))
        return undefined;
    if (report.firstFailure) {
        const expected = run.options.tests?.cases.find(row => row.id === report.firstFailure!.caseId);
        const { caseId, functionName, args, kwargs, expected: expectedValue, hint } = report.firstFailure;
        const supplied = {
            functionName, args, kwargs, expected: expectedValue, ...(hint === undefined ? {} : {
                hint
            })
        };
        if (!expected || JSON.stringify({
            ...expected, id: undefined
        }) !== JSON.stringify({
            ...supplied, id: undefined
        }) || caseId !== expected.id)
            return undefined;
    }
    return report;
}
/** One runtime per mounted consumer. Termination also discards its Python state. */
export function createPythonWorkerClient(factory: () => WorkerPort, options: {
    loadTimeoutMs?: number;
    runTimeoutMs?: number;
    preparationTimeoutMs?: number;
} = {}) {
    let worker: WorkerPort | null = null, loaded = false, disposed = false, sequence = 0, pending: Pending | null = null;
    let loading: Promise<void> | null = null, loadResolve: (() => void) | null = null, loadReject: ((reason: Error) => void) | null = null, loadTimer: ReturnType<typeof setTimeout> | null = null;
    let scientificReady: 'numpy' | 'pandas' | null = null, preparingRun = false;
    let generation = 0;
    let stoppedReason: Error | undefined;
    let workerHasRun = false;
    function stop(error: Error) {
        generation++;
        stoppedReason = error;
        worker?.terminate();
        worker = null;
        loaded = false;
        scientificReady = null;
        workerHasRun = false;
        if (loadTimer)
            clearTimeout(loadTimer);
        loadTimer = null;
        const rejectLoading = loadReject;
        loadResolve = null;
        loadReject = null;
        loading = null;
        rejectLoading?.(error);
        const run = pending;
        pending = null;
        if (run) {
            clearTimeout(run.timer);
            run.reject(error);
        }
    }
    function ready(scientificLibraries?: 'numpy' | 'pandas'): Promise<void> {
        const scientificWarmup = scientificLibraries !== undefined;
        if (disposed)
            return Promise.reject(failure('运行环境已关闭。', 'AbortError'));
        if (loaded)
            return Promise.resolve();
        if (loading)
            return loading;
        loading = new Promise<void>((resolve, reject) => {
            loadResolve = resolve;
            loadReject = reject;
        });
        const result = loading;
        try {
            const current = factory();
            worker = current;
            workerHasRun = false;
            current.onerror = event => {
                event.preventDefault?.();
                if (worker === current)
                    stop(failure('运行环境意外停止，请重新加载。'));
            };
            current.onmessage = event => {
                if (worker !== current)
                    return;
                const data = event.data;
                if (!data || typeof data !== 'object')
                    return;
                if (data.type === 'ready') {
                    if (scientificWarmup && (data.scientificWarmup !== true || data.scientificLibraries !== scientificLibraries)) {
                        stop(failure('运行环境版本不支持科学库准备，请刷新网页后重试。', 'RuntimeError'));
                        return;
                    }
                    scientificReady = scientificLibraries ?? null;
                    loaded = true;
                    if (loadTimer)
                        clearTimeout(loadTimer);
                    loadTimer = null;
                    const resolve = loadResolve;
                    loadResolve = null;
                    loadReject = null;
                    loading = null;
                    resolve?.();
                }
                else if (data.type === 'load-error')
                    stop(failure(typeof data.error === 'string' ? data.error.slice(0, 4000) : '运行环境加载失败。'));
                else if (pending && data.id === pending.id && data.type === 'running' && !pending.started) {
                    startProgramBudget(pending);
                }
                else if (pending && data.id === pending.id && ['result', 'error', 'prepare-error'].includes(data.type)) {
                    const run = pending;
                    pending = null;
                    clearTimeout(run.timer);
                    const report = data.report === undefined ? undefined : acceptedReport(data, run);
                    if (data.report !== undefined && !report) {
                        run.reject(failure('执行报告与当前作答不匹配或格式无效，暂不能判定。', 'ProtocolError'));
                        return;
                    }
                    if (data.type !== 'result')
                        run.reject(Object.assign(failure(typeof data.error === 'string' ? data.error.slice(0, 20000) : '代码运行失败。', data.type === 'error' ? 'PythonError' : 'RuntimeError'), {
                            executionPhase: report?.phase ?? (['preparation', 'test-definition', 'program', 'tests'].includes(data.executionPhase) ? data.executionPhase : undefined),
                            assertionFailure: report ? report.exception?.isAssertion === true && report.outcome === 'student-error' : data.assertionFailure === true,
                            testDefinitionError: report ? report.outcome === 'test-error' : data.testDefinitionError === true,
                            ...(report ? {
                                report
                            } : {}),
                        }));
                    else
                        run.resolve({
                            output: typeof data.output === 'string' ? data.output.slice(0, 20000) : '', result: data.result, assertionsPassed: report ? report.assertionsPassed : (Number.isSafeInteger(data.assertionsPassed) && data.assertionsPassed > 0 ? data.assertionsPassed : undefined), ...(report ? {
                                report
                            } : {})
                        });
                }
            };
            loadTimer = setTimeout(() => stop(failure(scientificWarmup ? '科学运行库准备超时，请检查网络后重试。' : '运行环境加载超时，请检查网络后重试。', scientificWarmup ? 'RuntimeError' : 'TimeoutError')), scientificWarmup ? options.preparationTimeoutMs ?? 60000 : options.loadTimeoutMs ?? 60000);
            current.postMessage({
                type: 'init', ...(scientificWarmup ? { scientificWarmup: true, scientificLibraries } : {})
            });
        }
        catch (error) {
            stop(error instanceof Error ? error : failure('无法启动运行环境。'));
        }
        return result;
    }
    function startProgramBudget(run: Pending) {
        run.started = true;
        clearTimeout(run.timer);
        run.timer = setTimeout(() => stop(failure('运行超过时间限制，已停止。输入仍保留，可修改后重新加载环境。', 'TimeoutError')), options.runTimeoutMs ?? 10000);
    }
    async function run(code: string, stdin = '', captureOutput = true, testCode?: string, runOptions: CodeRunOptions = {}): Promise<PythonRunResult> {
        const supplied = parseCodeRunOptions(runOptions);
        if (supplied.tests && testCode !== undefined)
            throw failure('结构化函数案例与旧测试脚本不能同时使用。');
        if (pending || preparingRun)
            throw failure('已有代码正在运行，请先停止。');
        if (code.length > 100000 || stdin.length > 10000 || (testCode?.length ?? 0) > 100000)
            throw failure('代码或输入过长，请缩短后重试。');
        const requestedGeneration = generation;
        await ready();
        if (requestedGeneration !== generation) throw stoppedReason ?? failure('运行已停止，输入仍保留。', 'AbortError');
        if (pending || preparingRun)
            throw failure('已有代码正在运行，请先停止。');
        preparingRun = true;
        try {
            const required = scientificRuntimeRequirement(code + '\n' + (testCode ?? ''));
            if (required && scientificReady !== required && scientificReady !== 'pandas') {
                // A previously used Python instance may have modified import state.
                worker?.terminate(); worker = null; loaded = false;
                await ready(required);
            }
            if (requestedGeneration !== generation) throw stoppedReason ?? failure('运行已停止，输入仍保留。', 'AbortError');
            if (!worker || disposed)
                throw failure('运行环境已关闭。', 'AbortError');
            return new Promise((resolve, reject) => {
                const id = ++sequence;
                pending = {
                    id, started: false, options: supplied, originalLineCount: code.split('\n').length, resolve, reject, timer: setTimeout(() => stop(failure('运行依赖准备超时，请检查网络后重试。', 'RuntimeError')), options.preparationTimeoutMs ?? 60000)
                };
                try {
                    // These flags belong to the host, beyond learner js.eval access.
                    if (scientificReady && workerHasRun) startProgramBudget(pending);
                    workerHasRun = true;
                    worker!.postMessage({
                        type: 'run', id, code, stdin, captureOutput, testCode, ...supplied
                    });
                }
                catch (error) {
                    stop(error instanceof Error ? error : failure('无法发送运行请求。'));
                }
            });
        } finally { preparingRun = false; }
    }
    return {
        ready: () => ready(), run, cancel: () => stop(failure('运行已停止，输入仍保留。', 'AbortError')), dispose: () => {
            disposed = true;
            stop(failure('运行环境已关闭。', 'AbortError'));
        }, isReady: () => loaded
    };
}
