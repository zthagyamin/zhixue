/* Runs only inside the opaque, network-restricted Python sandbox. */
let python = null, loading = null, busy = false, checkAssertions = null, validateTests = null, executeReport = null;
const MAX_OUTPUT = 20000;
async function initialize() {
    if (python)
        return python;
    if (!loading)
        loading = (async () => {
            if (typeof self.__zhixueSandboxRuntime !== 'function')
                throw new Error('必须通过隔离环境运行 Python。');
            const isolated = await self.__zhixueSandboxRuntime();
            python = isolated.python;
            const helpers = python.toPy({});
            try {
                python.runPython(isolated.checker, {
                    globals: helpers
                });
                checkAssertions = helpers.get('_zhixue_run_tests');
                validateTests = helpers.get('_zhixue_validate_tests');
                executeReport = helpers.get('_zhixue_execute_report');
            }
            finally {
                helpers.destroy();
            }
            return python;
        })();
    try {
        return await loading;
    }
    catch (error) {
        loading = null;
        python = null;
        throw error;
    }
}
self.onmessage = async (event) => {
    const request = event.data;
    if (request?.type === 'init') {
        try {
            await initialize();
            self.postMessage({
                type: 'ready'
            });
        }
        catch (error) {
            self.postMessage({
                type: 'load-error', error: String(error).slice(0, 4000)
            });
        }
        return;
    }
    if (request?.type !== 'run' || !python || busy)
        return;
    busy = true;
    let namespace = null, runner = null, result = null, output = '', executing = false, truncated = false, executionPhase = 'preparation';
    let prefixLineCount = 0;
    const original = String(request.code);
    const append = value => {
        if (!request.captureOutput || truncated)
            return;
        const next = output + value + '\n';
        if (next.length > MAX_OUTPUT) {
            output = next.slice(0, MAX_OUTPUT - 20) + '\n[输出已截断]';
            truncated = true;
        }
        else
            output = next;
    };
    try {
        let code = original;
        const combined = code + '\n' + (request.testCode ?? '');
        for (const [alias, module, statement] of [['np.', 'numpy', 'import numpy as np'], ['pd.', 'pandas', 'import pandas as pd'], ['math.', 'math', 'import math']]) {
            if (combined.includes(alias) && !combined.includes('import ' + module)) {
                code = statement + '\n' + code;
                prefixLineCount++;
            }
        }
        const packageErrors = [];
        await python.loadPackagesFromImports(code + '\n' + (request.testCode ?? ''), {
            errorCallback: message => packageErrors.push(String(message).slice(0, 1000))
        });
        if (packageErrors.length)
            throw new Error('运行依赖加载失败：' + packageErrors.slice(0, 5).join('\n'));
        const lines = String(request.stdin ?? '').replace(/\r\n/g, '\n').split('\n');
        let index = 0;
        if (!request.stdin)
            lines.length = 0;
        python.setStdin({
            stdin: () => index < lines.length ? lines[index++] : null
        });
        python.setStdout({
            batched: append
        });
        python.setStderr({
            batched: append
        });
        namespace = python.toPy({
            __name__: '__main__'
        });
        self.postMessage({
            type: 'running', id: request.id
        });
        executing = true;
        executionPhase = 'program';
        if (executeReport) {
            runner = python.toPy({
                __zhixue_report_runner: executeReport, __zhixue_code: code, __zhixue_tests: request.testCode ?? undefined,
                __zhixue_support: request.tests ? JSON.stringify(request.tests) : undefined, __zhixue_namespace: namespace, __zhixue_prefix: prefixLineCount
            });
            result = await python.runPythonAsync('await __zhixue_report_runner(__zhixue_code, __zhixue_tests, __zhixue_support, __zhixue_namespace, __zhixue_prefix)', {
                globals: runner
            });
            const payload = JSON.parse(String(result));
            const report = {
                ...payload.report, runId: request.id, ...(request.identity ? {
                    identity: request.identity
                } : {})
            };
            executionPhase = report.phase;
            const common = {
                id: request.id, output, report, executionPhase, assertionFailure: report.exception?.isAssertion === true && report.outcome === 'student-error', testDefinitionError: report.outcome === 'test-error', assertionsPassed: report.assertionsPassed
            };
            if (report.status === 'passed')
                self.postMessage({
                    ...common, type: 'result', result: payload.result
                });
            else
                self.postMessage({
                    ...common, type: report.outcome === 'environment-error' || report.outcome === 'test-error' ? 'prepare-error' : 'error', error: (output + (payload.error ?? '公开函数案例返回值与预期不一致。')).slice(0, MAX_OUTPUT)
                });
        }
        else {
            // Older helper compatibility: only a measured success is evidence. Errors
            // without Python exception metadata remain unassigned; never inspect text.
            if (typeof request.testCode === 'string') {
                executionPhase = 'test-definition';
                validateTests(request.testCode);
            }
            executionPhase = 'program';
            result = await python.runPythonAsync(code, {
                globals: namespace
            });
            executionPhase = 'tests';
            const assertionsPassed = typeof request.testCode === 'string' ? checkAssertions(request.testCode, namespace) : undefined;
            self.postMessage({
                type: 'result', id: request.id, output, result: result == null ? null : String(result).slice(0, MAX_OUTPUT), assertionsPassed
            });
        }
    }
    catch (error) {
        self.postMessage({
            type: executing && executionPhase !== 'test-definition' ? 'error' : 'prepare-error', id: request.id, error: (output + String(error)).slice(0, MAX_OUTPUT), executionPhase, testDefinitionError: executionPhase === 'test-definition', assertionFailure: false, report: {
                schemaVersion: 1, runId: request.id, ...(request.identity ? {
                    identity: request.identity
                } : {}), status: 'failed', phase: executionPhase, outcome: executionPhase === 'preparation' ? 'environment-error' : executionPhase === 'test-definition' ? 'test-error' : 'unknown', assertionsPassed: 0, assertionsExecuted: 0, mapping: {
                    prefixLineCount, originalLineCount: original.split('\n').length
                }
            }
        });
    }
    finally {
        try {
            result?.destroy?.();
            runner?.destroy?.();
            namespace?.destroy?.();
            python.setStdout({
                batched: () => {
                }
            });
            python.setStderr({
                batched: () => {
                }
            });
            python.setStdin({
                stdin: () => null
            });
        }
        catch {
            // A later run or termination resets the runtime.
        }
        busy = false;
    }
};
