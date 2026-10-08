// @ts-expect-error TS5097: standalone Node contracts.
import { normalizeCodeRunReport } from '../code-execution/index.ts';
import type { CodeRunReportV1 } from '../code-execution/index.ts';
export type CodePracticeResult = {
    kind: string;
    message: string;
    details: string;
    assertionsPassed?: number;
    report?: CodeRunReportV1;
};
export function codeRunSuccess(result: {
    output: string;
    result?: unknown;
    assertionsPassed?: number;
    report?: CodeRunReportV1;
}, mode: 'tests' | 'trial'): CodePracticeResult {
    const report = normalizeCodeRunReport(result.report);
    if (result.report !== undefined && (!report || report.status !== 'passed'))
        return {
            kind: 'unknown', message: '执行报告无效，暂不能判定。', details: result.output
        };
    const assertionsPassed = report?.assertionsPassed ?? result.assertionsPassed;
    const evidence = report ? {report} : {};
    const details = result.output || (result.result === undefined ? '' : String(result.result));
    if (mode === 'trial')
        return {
            kind: 'trial', message: '试运行结束，未判定通过。', details, ...evidence
        };
    if (!Number.isSafeInteger(assertionsPassed) || !assertionsPassed || assertionsPassed < 1)
        return {
            kind: 'test-error', message: '题目测试未执行有效断言，不能判通过。', details, ...evidence
        };
    return {
        kind: 'checked', message: `本次辅助练习通过 ${assertionsPassed} 项公开断言；不改变首次结果。`, details, assertionsPassed, ...evidence
    };
}
export function codeRunFailure(error: unknown): CodePracticeResult {
    const value = error as {
        name?: string;
        message?: string;
        executionPhase?: string;
        assertionFailure?: boolean;
        testDefinitionError?: boolean;
        report?: unknown;
    } | null;
    const details = (value?.message ?? String(error)).slice(0, 20000);
    if (value?.name === 'AbortError')
        return {
            kind: 'cancelled', message: '运行已停止，输入仍在本页。', details
        };
    if (value?.name === 'TimeoutError')
        return {
            kind: 'timeout', message: '运行超时，尚未判通过。', details
        };
    if (value?.report !== undefined) {
        const report = normalizeCodeRunReport(value.report);
        if (!report || report.status !== 'failed')
            return {
                kind: 'unknown', message: '执行报告无效，暂不能判定。', details
            };
        const messages = {
            'student-error': '程序运行或公开检查未通过，请核对具体情形。', 'test-error': '题目测试定义异常，不能据此判学生错误。', 'environment-error': '执行环境或依赖准备失败，尚未判定作答。', unknown: '测试或执行异常，暂不能确定作答结果。', success: '执行报告状态矛盾，暂不能判定。'
        };
        return {
            kind: report.outcome, message: messages[report.outcome], details, report
        };
    }
    if (value?.testDefinitionError || value?.executionPhase === 'test-definition')
        return {
            kind: 'test-error', message: '题目测试定义异常，不能据此判学生错误。', details
        };
    if (value?.name === 'RuntimeError')
        return {
            kind: 'environment-error', message: '执行环境或依赖准备失败，尚未判定作答。', details
        };
    if (value?.executionPhase === 'tests' && !value.assertionFailure)
        return {
            kind: 'unknown', message: '测试执行异常，暂不能区分测试脚手架与被测程序问题。', details
        };
    if (value?.name === 'PythonError' && (value.executionPhase === 'program' || value.assertionFailure))
        return {
            kind: 'student-error', message: '程序运行或断言未通过，请核对失败情形。', details
        };
    return {
        kind: 'unknown', message: '执行未能完成，暂不能确定是程序还是环境问题。', details
    };
}
