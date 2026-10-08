// @ts-expect-error TS5097: standalone Node contracts.
import {parseCalculationSupport, type CalculationSupport} from '../content/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {compareExpressions, numericEquivalent} from '../math/index.ts';

export type CalculationStepDiagnosis = {
    status: 'correct' | 'incorrect' | 'undetermined';
    source: 'deterministic';
    explanation: string;
};
const diagnosis = (status: CalculationStepDiagnosis['status'], explanation: string): CalculationStepDiagnosis =>
    ({status, source: 'deterministic', explanation});

/** Only the source-authored expression/value is checked, never a proof or formal rating.
 * The controlled service must resolve this support from the current authoritative source.
 */
export function gradeCalculationStep(answer: string, support: CalculationSupport): CalculationStepDiagnosis {
    try {
        const parsed = parseCalculationSupport(support);
        if (parsed.schemaVersion !== 2 || !parsed.step || typeof answer !== 'string' || !answer.trim())
            return diagnosis('undetermined', '尚未作答可诊断的步骤。');
        const step = parsed.step;
        if (step.mode === 'semantic')
            return diagnosis('undetermined', '此步骤需要受控服务按来源参考核对语义。');
        if (step.mode === 'numeric') {
            const correct = numericEquivalent(answer, step.reference, parsed.tolerance ?? '0.000001');
            return correct === null
                ? diagnosis('undetermined', '此步骤的数值格式超出当前内核支持范围。')
                : diagnosis(correct ? 'correct' : 'incorrect', correct ? '此步骤的数值与来源参考一致。' : '此步骤的数值与来源参考不一致。');
        }
        const result = compareExpressions(answer, step.reference, parsed.variables);
        // Free-text conditions may restrict the real domain. A globally unequal polynomial
        // is not proof of inequality on that subset; the kernel does not interpret prose.
        if (result.verdict === 'wrong' && parsed.conditions?.length)
            return diagnosis('undetermined', '当前内核不能核对这些附加条件下的表达式差异。');
        return diagnosis(result.verdict === 'unknown' ? 'undetermined' : result.verdict === 'correct' ? 'correct' : 'incorrect', result.explanation);
    } catch {
        return diagnosis('undetermined', '此步骤缺少有效的来源参考或超出支持范围。');
    }
}
