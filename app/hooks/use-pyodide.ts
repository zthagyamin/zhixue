import type { CodeRunOptions } from '../../src/domain/code-execution/index.ts';
import { useState, useEffect, useRef } from 'react';
import { createPythonWorkerClient } from '../python-worker-client';
import { createPythonSandboxWorker } from '../python-sandbox';
export function usePyodide() {
    const client = useRef<ReturnType<typeof createPythonWorkerClient> | null>(null);
    const [isReady, setIsReady] = useState(false), [error, setError] = useState<string | null>(null), [epoch, setEpoch] = useState(0);
    useEffect(() => {
        let active = true;
        const current = createPythonWorkerClient(() => createPythonSandboxWorker());
        client.current = current;
        current.ready().then(() => {
            if (active)
                setIsReady(true);
        }).catch(reason => {
            if (active) {
                setIsReady(false);
                setError(reason instanceof Error ? reason.message : String(reason));
            }
        });
        return () => {
            active = false;
            if (client.current === current)
                client.current = null;
            current.dispose();
        };
    }, [epoch]);
    async function runPython(code: string, captureOutput = true, stdin = '', testCode?: string, options?: CodeRunOptions) {
        const current = client.current;
        if (!current)
            throw new Error('运行环境尚未就绪。');
        try {
            return await current.run(code, stdin, captureOutput, testCode, options);
        }
        finally {
            if (client.current === current && !current.isReady()) {
                setIsReady(false);
                setError('运行环境已停止。重新加载即可继续，输入保持不变。');
            }
        }
    }
    const retry = () => {
        setIsReady(false);
        setError(null);
        setEpoch(value => value + 1);
    };
    function cancel() {
        client.current?.cancel();
        setIsReady(false);
        setError('运行已停止，重新加载后可以继续。');
    }
    return {
        isReady, error, runPython, retry, cancel
    };
}
