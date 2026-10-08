// @ts-expect-error TS5097: standalone Node contracts.
import { normalizeCodeRunReport } from '../code-execution/index.ts';
import type { CodeRunReportV1 } from '../code-execution/index.ts';
export type CodeFeedbackLocation = {
    file: string;
    line: number;
    functionName?: string;
};
export type CodeFailureFeedback = {
    summary: string;
    report?: CodeRunReportV1;
    firstFailure?: CodeRunReportV1["firstFailure"];
    exception?: string;
    location?: CodeFeedbackLocation;
    assertionSource?: string;
};
type Frame = CodeFeedbackLocation & {
    index: number;
};
const brief = (text: string, limit: number) => text.length <= limit ? text : text.slice(0, limit) + '…（完整内容见运行详情）';
/** Observed execution text only. This formatter never attributes blame or evaluates an assertion. */
export function formatCodeFailureFeedback(error: unknown, options: {
    testCode?: string;
} = {}): CodeFailureFeedback {
    const supplied = error as {
        message?: unknown;
        name?: unknown;
        assertionFailure?: unknown;
        report?: unknown;
    } | null;
    const report = normalizeCodeRunReport(supplied?.report);
    if (report && report.status === 'failed') {
        const fault = report.exception, firstFailure = report.firstFailure;
        const exception = fault ? `${fault.kind}${fault.message ? ': ' + fault.message : ''}` : undefined;
        const loc = fault?.location;
        const location = loc ? {
            file: loc.file, line: loc.originalLine ?? loc.line, ...(loc.functionName ? {
                functionName: loc.functionName
            } : {})
        } : undefined;
        const parts = [exception ? brief(exception, 600) : firstFailure ? '公开函数案例返回值与预期不一致。' : '执行暂不能判定，请展开详情核对。'];
        if (location)
            parts.push(`${loc?.origin === 'preparation' ? '依赖准备位置' : '运行位置'}：${brief(location.file, 220)}，第 ${location.line} 行`);
        if (firstFailure) {
            parts.push(`失败检查：${firstFailure.caseId}（${firstFailure.functionName}）`, `输入：${brief(JSON.stringify({
                args: firstFailure.args, kwargs: firstFailure.kwargs
            }), 240)}`, `期望：${brief(JSON.stringify(firstFailure.expected), 240)}`, `实际：${brief(JSON.stringify(firstFailure.actual), 240)}`);
        }
        let assertionSource: string | undefined;
        if (fault?.isAssertion && loc?.origin === 'tests' && options.testCode) {
            const source = options.testCode.split(/\r?\n/)[loc.line - 1];
            if (source && /^\s*assert\b/.test(source))
                assertionSource = source;
        }
        if (assertionSource)
            parts.push(assertionSource.length <= 500 ? `断言来源：${assertionSource}` : '断言来源较长，请在题目测试或运行详情中查看完整内容。');
        return {
            summary: parts.join('\n'), report, ...(firstFailure ? {
                firstFailure
            } : {}), ...(exception ? {
                exception
            } : {}), ...(location ? {
                location
            } : {}), ...(assertionSource ? {
                assertionSource
            } : {})
        };
    }
    const raw = (typeof supplied?.message === 'string' ? supplied.message : String(error)).slice(0, 20000);
    const lines = raw.split(/\r?\n/);
    let start = 0, hasTraceback = false;
    for (let index = 0; index < lines.length; index++) {
        if (/Traceback \(most recent call last\):/.test(lines[index])) {
            start = index + 1;
            hasTraceback = true;
        }
    }
    const last = lines.slice(start).map(line => line.trim()).filter(Boolean).at(-1) ?? '';
    const standardException = /^(?:[A-Za-z_][\w.]*(?:Error|Exception|Warning)|KeyboardInterrupt|SystemExit|GeneratorExit|StopIteration)(?::.*)?$/;
    const customException = /^[A-Za-z_][\w.]*(?::.*)?$/;
    let exception = standardException.test(last) || hasTraceback && customException.test(last) ? last : undefined;
    if (!exception && lines.length === 1 && typeof supplied?.name === 'string' && supplied.name !== 'PythonError'
        && standardException.test(supplied.name) && last)
        exception = `${supplied.name}: ${last}`;
    let frame: Frame | undefined;
    for (let index = start; index < lines.length; index++) {
        const match = /^\s*File ["']([^"']+)["'], line (\d+)(?:, in (.+))?\s*$/.exec(lines[index]);
        if (!match)
            continue;
        const line = Number(match[2]);
        if (Number.isSafeInteger(line) && line > 0)
            frame = {
                file: match[1], line,
                ...(match[3] ? {
                    functionName: match[3].trim()
                } : {}), index
            };
    }
    const location = frame ? {
        file: frame.file, line: frame.line,
        ...(frame.functionName ? {
            functionName: frame.functionName
        } : {})
    } : undefined;
    let assertionSource: string | undefined;
    if (frame && (/^AssertionError(?::|$)/.test(exception ?? '') || supplied?.assertionFailure === true)) {
        // Only the deepest observed frame can identify the failing assertion. An
        // outer public assert may merely be calling learner code that raised inside it.
        const inline = lines[frame.index + 1];
        if (inline && /^\s*assert\b/.test(inline))
            assertionSource = inline;
        else if (frame.file === '<题目测试>' && typeof options.testCode === 'string') {
            const provided = options.testCode.split(/\r?\n/)[frame.line - 1];
            if (provided && /^\s*assert\b/.test(provided))
                assertionSource = provided;
        }
    }
    const parts = [exception ? brief(exception, 600) : '运行未提供具体异常末行，请展开详情核对。'];
    if (location)
        parts.push(`运行位置：${brief(location.file, 220)}，第 ${location.line} 行${location.functionName ? `（${brief(location.functionName, 100)}）` : ''}`);
    if (assertionSource)
        parts.push(assertionSource.length <= 500 ? `断言来源：${assertionSource}` : '断言来源较长，请在题目测试或运行详情中查看完整内容。');
    return {
        summary: parts.join('\n'), ...(exception ? {
            exception
        } : {}), ...(location ? {
            location
        } : {}),
        ...(assertionSource ? {
            assertionSource
        } : {})
    };
}
