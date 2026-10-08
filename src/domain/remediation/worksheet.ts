// @ts-expect-error TS5097: standalone Node contracts.
import {compareExpressions,numericEquivalent} from '../math/index.ts';

export type RemedyKind = 'condition' | 'distinction' | 'recalculate' | 'debug';
export type SourceWorksheet = {
    kind: RemedyKind; binding: string; target: string; reference: string;
    mode: 'source-review'; automaticallyScored: false; instruction: string;
};
const instructions: Record<RemedyKind,string> = {
    condition: '写清适用条件，再提出一个不满足条件的情形。这里只与原材料对照，不自动判断反例是否成立。',
    distinction: '解释原选项为什么不成立、与正确说法有何区别。请依据材料，不必照抄答案。',
    recalculate: '写下要重算的关键一步与最终结果。仅核对结果，不自动证明整个推导正确。',
    debug: '针对本次运行输出选择一个失败情形，修改临时代码后重新测试。',
};
/** No generated standard answers, semantic claims or scheduling output. */
export function sourceWorksheet(input: {kind: RemedyKind; binding: string; target: string; reference: string}): SourceWorksheet | null {
    if (!input.binding || !input.target.trim() || !input.reference.trim() || input.reference.length > 12000) return null;
    return {...input, mode: 'source-review', automaticallyScored: false, instruction: instructions[input.kind]};
}
export function quizMistakes(support: {correctOptionIds: readonly string[]; options: readonly {optionId: string}[]}, selected: readonly string[]) {
    return {wrong: selected.filter(id => !support.correctOptionIds.includes(id)), missing: support.correctOptionIds.filter(id => !selected.includes(id))};
}
export function recalculationResult(answer: string, expected: string | number, support?: {mode?: string; variables?: string[]; tolerance?: string}) {
    const result = support?.mode === 'symbolic' ? compareExpressions(answer, String(expected), support.variables ?? []) : null;
    const equivalent = result ? result.verdict === 'unknown' ? null : result.verdict === 'correct' : numericEquivalent(answer, String(expected), support?.tolerance ?? '0.000001');
    return equivalent === null ? {kind:'unknown',message:'当前语法或条件无法自动核对，请对照原材料；没有判作答错误。'} : equivalent ?
        {kind:'checked',message:'这个结果与参考一致。这是辅助核对，不改变首次作答或证明整个过程正确。'} :
        {kind:'different',message:'这个结果与参考不同，请重新核对计算或输入；原作答记录不变。'};
}
