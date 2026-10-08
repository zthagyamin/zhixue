// @ts-expect-error TS5097: standalone Node contracts.
import { boundedCodeJSON, codeJSONEqual, codeObject, codeText, parseCodeLearningSupportV1 } from '../content/index.ts';
import type { CodeFunctionCase, CodeJSON, CodeLearningSupportV1 } from '../content/index.ts';
export type CodeRunIdentity = {
    attemptId: string;
    revision: number;
    sourceVersion: string;
    testVersion: string;
};
export type CodeRunOptions = {
    identity?: CodeRunIdentity;
    tests?: CodeLearningSupportV1;
};
export type CodeRunLocation = {
    origin: 'learner' | 'tests' | 'preparation';
    file: string;
    line: number;
    originalLine?: number;
    functionName?: string;
};
export type CodeRunException = {
    kind: string;
    message: string;
    isAssertion: boolean;
    location?: CodeRunLocation;
};
export type CodeRunReportV1 = {
    schemaVersion: 1;
    runId: number;
    identity?: CodeRunIdentity;
    status: 'passed' | 'failed';
    phase: 'preparation' | 'test-definition' | 'program' | 'tests';
    outcome: 'success' | 'student-error' | 'test-error' | 'environment-error' | 'unknown';
    assertionsPassed: number;
    assertionsExecuted: number;
    mapping: {
        prefixLineCount: number;
        originalLineCount: number;
    };
    exception?: CodeRunException;
    firstFailure?: Omit<CodeFunctionCase, 'id'> & {
        caseId: string;
        actual: CodeJSON;
    };
};
const integer = (raw: unknown, max: number, min = 0) => {
    if (typeof raw !== 'number' || !Number.isSafeInteger(raw) || raw < min || raw > max)
        throw Error('invalid-code-integer');
    return raw;
};
export function parseCodeRunIdentity(raw: unknown): CodeRunIdentity {
    const row = codeObject(raw, ['attemptId', 'revision', 'sourceVersion', 'testVersion']);
    return {
        attemptId: codeText(row.attemptId), revision: integer(row.revision, Number.MAX_SAFE_INTEGER), sourceVersion: codeText(row.sourceVersion), testVersion: codeText(row.testVersion)
    };
}
export function parseCodeRunOptions(raw: unknown): CodeRunOptions {
    const row = codeObject(raw, [], ['identity', 'tests']);
    return {
        ...(row.identity === undefined ? {} : {
            identity: parseCodeRunIdentity(row.identity)
        }), ...(row.tests === undefined ? {} : {
            tests: parseCodeLearningSupportV1(row.tests)
        })
    };
}
export function parseCodeRunReport(raw: unknown): CodeRunReportV1 {
    const row = codeObject(raw, ['schemaVersion', 'runId', 'status', 'phase', 'outcome', 'assertionsPassed', 'assertionsExecuted', 'mapping'], ['identity', 'exception', 'firstFailure']);
    if (row.schemaVersion !== 1 || !['passed', 'failed'].includes(row.status as string) || !['preparation', 'test-definition', 'program', 'tests'].includes(row.phase as string) || !['success', 'student-error', 'test-error', 'environment-error', 'unknown'].includes(row.outcome as string))
        throw Error('invalid-code-report');
    const assertionsPassed = integer(row.assertionsPassed, 1000000), assertionsExecuted = integer(row.assertionsExecuted, 1000000);
    const mappingRow = codeObject(row.mapping, ['prefixLineCount', 'originalLineCount']);
    const mapping = {
        prefixLineCount: integer(mappingRow.prefixLineCount, 3), originalLineCount: integer(mappingRow.originalLineCount, 100001, 1)
    };
    if (assertionsPassed > assertionsExecuted || (row.status === 'passed') !== (row.outcome === 'success') || row.status === 'passed' && (row.exception !== undefined || row.firstFailure !== undefined) || row.status === 'failed' && row.phase === 'tests' && row.outcome === 'student-error' && !row.exception && !row.firstFailure || row.outcome === 'environment-error' && row.phase !== 'preparation' || row.outcome === 'test-error' && row.phase !== 'test-definition')
        throw Error('contradictory-code-report');
    let exception: CodeRunException | undefined;
    if (row.exception !== undefined) {
        const value = codeObject(row.exception, ['kind', 'message', 'isAssertion'], ['location']);
        const kind = codeText(value.kind, 128);
        if (typeof value.message !== 'string' || value.message.length > 4000 || typeof value.isAssertion !== 'boolean' || value.isAssertion && kind !== 'AssertionError')
            throw Error('invalid-code-exception');
        let location: CodeRunLocation | undefined;
        if (value.location !== undefined) {
            const loc = codeObject(value.location, ['origin', 'file', 'line'], ['originalLine', 'functionName']);
            if (!['learner', 'tests', 'preparation'].includes(loc.origin as string))
                throw Error('invalid-code-location');
            location = {
                origin: loc.origin as CodeRunLocation['origin'], file: codeText(loc.file, 240), line: integer(loc.line, 100010, 1), ...(loc.originalLine === undefined ? {} : {
                    originalLine: integer(loc.originalLine, mapping.originalLineCount, 1)
                }), ...(loc.functionName === undefined ? {} : {
                    functionName: codeText(loc.functionName, 128)
                })
            };
            if ((location.origin === 'tests' ? location.file !== '<题目测试>' : location.file !== '<learner>') || location.origin === 'preparation' && location.line > mapping.prefixLineCount) throw Error('invalid-code-location-origin');
            if (location.origin === 'learner' && (location.originalLine === undefined || location.line !== location.originalLine + mapping.prefixLineCount) || location.origin !== 'learner' && location.originalLine !== undefined)
                throw Error('invalid-code-line-mapping');
        }
        exception = {
            kind, message: value.message, isAssertion: value.isAssertion, ...(location ? {
                location
            } : {})
        };
    }
    let firstFailure: CodeRunReportV1['firstFailure'];
    if (row.firstFailure !== undefined) {
        const value = codeObject(row.firstFailure, ['caseId', 'functionName', 'args', 'kwargs', 'expected', 'actual'], ['hint']);
        const support = parseCodeLearningSupportV1({
            schemaVersion: 1, type: 'code', functionNames: [value.functionName], cases: [{
                    id: value.caseId, functionName: value.functionName, args: value.args, kwargs: value.kwargs, expected: value.expected, ...(value.hint === undefined ? {} : {
                        hint: value.hint
                    })
                }]
        });
        const { id, ...item } = support.cases[0];
        firstFailure = {
            ...item, caseId: id, actual: boundedCodeJSON(value.actual)
        };
    }
    if (row.outcome === 'student-error' && !firstFailure && !(exception?.location?.origin === 'learner' || row.phase === 'tests' && exception?.isAssertion && exception.location?.origin === 'tests'))
        throw Error('untrusted-code-attribution');
    if (row.outcome === 'success' && assertionsPassed !== assertionsExecuted) throw Error('contradictory-code-count');
    if (firstFailure && codeJSONEqual(firstFailure.expected, firstFailure.actual)) throw Error('contradictory-code-values');
    if (firstFailure && (row.phase !== 'tests' || row.outcome !== 'student-error' || assertionsExecuted !== assertionsPassed + 1))
        throw Error('contradictory-code-case');
    if (row.outcome === 'success' && !['program', 'tests'].includes(row.phase as string))
        throw Error('contradictory-code-success');
    const report = {
        schemaVersion: 1, runId: integer(row.runId, Number.MAX_SAFE_INTEGER, 1), status: row.status, phase: row.phase, outcome: row.outcome, assertionsPassed, assertionsExecuted, mapping, ...(row.identity === undefined ? {} : {
            identity: parseCodeRunIdentity(row.identity)
        }), ...(exception ? {
            exception
        } : {}), ...(firstFailure ? {
            firstFailure
        } : {})
    } as CodeRunReportV1;
    if (JSON.stringify(report).length > 64000)
        throw Error('code-report-size');
    return report;
}
export function normalizeCodeRunReport(raw: unknown): CodeRunReportV1 | undefined {
    try {
        return parseCodeRunReport(raw);
    }
    catch {
        return undefined;
    }
}
