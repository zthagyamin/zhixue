import type { PracticeMode as PluginType, LearningSupport } from '../content/index';
// @ts-expect-error TS5097: standalone Node contract tests.
import { parseLearningSupport, assessmentContentShape, needsConcreteRecallQuestion, courseTaskReadiness, hasExecutableCodeMaterial } from '../content/index.ts';
// @ts-expect-error TS5097: standalone Node contract tests.
import { recallReference } from './recall-reference.ts';
// @ts-expect-error TS5097: standalone Node contract tests.
import { compareExpressions, numericEquivalent } from '../math/index.ts';
export const CONTENT_CHECK_VERSION = 'content-quality-v1';
export type ContentIssue = {
    code: string;
    severity: 'blocking' | 'notice';
    field: string;
    message: string;
};
export type ContentCheck = {
    checkerVersion: typeof CONTENT_CHECK_VERSION;
    capabilities: {
        canDisplay: boolean;
        canSelfCheck: boolean;
        canAutoAssess: boolean;
    };
    issues: ContentIssue[];
};
function text(value: unknown): string {
    return typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}
function record(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
/** Read-only technical checks. Never claim a fact/reference was human-verified.
 * `canAutoAssess` means input preconditions, not proven model/test correctness.
 * Called on current content every time: no unscoped cross-owner result cache.
 */
export function checkContentQuality(mode: PluginType, input: unknown): ContentCheck {
    const data = assessmentContentShape(mode, record(input)), issues: ContentIssue[] = [];
    let canDisplay = Boolean(text(data.prompt) || text(data.front) || text(data.word) || mode === 'paper');
    let canSelfCheck = false, canAutoAssess = false;
    const issue = (code: string, field: string, message: string, severity: ContentIssue['severity'] = 'blocking') => issues.push({ code, severity, field, message });
    let support: LearningSupport | undefined;
    if (data.learningSupport !== undefined) {
        try {
            support = parseLearningSupport(data.learningSupport, mode);
        }
        catch {
            issue('invalid-learning-support', 'learningSupport', '本题学习配置不可用，请更新来源材料后再练习。');
            return { checkerVersion: CONTENT_CHECK_VERSION, capabilities: { canDisplay, canSelfCheck: false, canAutoAssess: false }, issues };
        }
    }
    if (!canDisplay)
        issue('missing-prompt', 'prompt', '本题缺少题目内容，请核对来源。');
    if (support && (support.type === 'recall' || support.type === 'quiz') && support.schemaVersion === 2) {
        if (support.type === 'recall' && ['answer', 'explanation', 'reviewPoint'].some(key => text(data[key])))
            issue('duplicate-course-reference', 'learningSupport', '课程任务的参考要点与旧参考字段重复，请更新来源后再练习。');
        for (const code of courseTaskReadiness(support.task, text(data.prompt), data.kind === 'word' || data.eventKind === 'word' || data.word !== undefined)) {
            const messages: Record<string, string> = {
                'course-task-word': '课程任务配置不能用于单词材料，请核对原始来源。',
                'course-task-unreviewed': '本题来源或参考尚待完善，材料保留，暂不计分。',
                'course-task-prompt-mismatch': '题面与已核验任务不一致，请更新来源后再练习。',
                'course-task-missing-conditions': '本题缺少成立或应用条件，暂不计分。',
                'unfocused-recall-question': '本题尚未提供具体问题，材料保留，暂不计分。',
            };
            issue(code, 'learningSupport.task', messages[code]);
        }
        if (issues.some(value => value.severity === 'blocking'))
            return { checkerVersion: CONTENT_CHECK_VERSION, capabilities: { canDisplay, canSelfCheck: false, canAutoAssess: false }, issues };
    }
    if (mode === 'recall') {
        const recallData={prompt:text(data.prompt),sourceLabel:text(data.sourceLabel),explanation:text(data.explanation),reviewPoint:text(data.reviewPoint),answer:text(data.answer)};
        if(needsConcreteRecallQuestion(recallData)) {
            issue('unfocused-recall-question','prompt','这份材料尚未提供具体问题，已暂停自测；原文和已有记录保留。');
            return {checkerVersion:CONTENT_CHECK_VERSION,capabilities:{canDisplay,canSelfCheck:false,canAutoAssess:false},issues};
        }
        const reference = recallReference(recallData, support?.type === 'recall' ? support.criteria : [], support?.type === 'recall' ? support.hints?.[2] : undefined);
        canSelfCheck = Boolean(reference);
        canAutoAssess = canSelfCheck;
        if (!reference)
            issue('missing-recall-reference', 'answer', '本题缺少可核对的参考要点，暂不计入成绩。');
    }
    else if (mode === 'quiz') {
        let options: {
            id: string;
            text: string;
        }[] = [], answers: string[] = [];
        if (support?.type === 'quiz') {
            options = support.options.map(option => ({ id: option.optionId, text: option.text }));
            answers = support.correctOptionIds;
        }
        else {
            const raw = data.options;
            if (Array.isArray(raw) && raw.length >= 2 && raw.every(value => typeof value === 'string' && value.trim())) {
                options = raw.map((value, index) => ({ id: String(index), text: String(value) }));
                if (typeof data.answer === 'number' && Number.isInteger(data.answer) && data.answer >= 0 && data.answer < options.length)
                    answers = [String(data.answer)];
                else if (typeof data.answer === 'string')
                    answers = options.filter(option => option.text === data.answer).map(option => option.id);
            }
            if (options.length < 2)
                issue('invalid-quiz-options', 'options', '本题需要至少两个有效选项。');
            if (answers.length !== 1)
                issue('invalid-quiz-answer', 'answer', '本题正确选项缺失或不唯一，暂不自动评分。');
        }
        const byText = new Map<string, boolean>();
        for (const option of options) {
            const normalized = option.text.normalize('NFC').replace(/\s+/gu, ' ').trim(), right = answers.includes(option.id);
            if (byText.has(normalized) && byText.get(normalized) !== right) {
                issue('ambiguous-quiz-options', 'options', '相同选项文本被标成不同正误，请先核对来源。');
                break;
            }
            byText.set(normalized, right);
        }
        canSelfCheck = canAutoAssess = !issues.some(value => value.severity === 'blocking');
    }
    else if (mode === 'calculation') {
        const expected = text(data.answer), reference = text(data.explanation) || text(data.reviewPoint);
        canSelfCheck = Boolean(expected || reference);
        canAutoAssess = Boolean(expected) && (support?.type === 'calculation' && support.mode === 'symbolic' ?
            compareExpressions(expected, expected, support.variables).verdict === 'correct' : numericEquivalent(expected, expected, '0') === true);
        if (!canSelfCheck)
            issue('missing-calculation-reference', 'answer', '本题缺少参考结果，请核对来源。');
        else if (!canAutoAssess)
            issue('unsupported-calculation-reference', 'answer', '参考内容超出自动判题范围，可核对来源；无法判定不代表答错。', 'notice');
    }
    else if (mode === 'code') {
        canSelfCheck = Boolean(text(data.solutionCode) || text(data.explanation));
        // A text check cannot prove assertions execute. The sandbox remains authoritative.
        canAutoAssess = hasExecutableCodeMaterial(data);
        if (!canAutoAssess)
            issue('missing-code-tests', 'testCode', '缺少初始代码或题目测试，不能自动判定通过。');
    }
    else if (mode === 'flashcard') {
        const back = data.back ?? data.answer ?? data.explanation;
        canSelfCheck = Boolean(text(back));
        if (support?.type === 'flashcard') {
            if (!support.parentId)
                issue('unexpanded-flashcard', 'learningSupport', '本组卡片尚未展开，请更新来源后重试。');
            if (support.mode === 'occlusion') {
                canSelfCheck = Boolean(support.masks.find(mask => mask.id === support.activeMaskId)?.answer.trim());
                // Decoding and asset-version checks remain enforced by FlashcardImage.
                issue('asset-readiness-required', 'learningSupport', '图片加载及版本核对完成后才可评分。', 'notice');
            }
        }
        if (!canSelfCheck)
            issue('missing-flashcard-reference', 'back', '本题缺少卡片背面或遮挡答案，暂不计入成绩。');
    }
    else if (mode === 'three-stage' || mode === 'spelling') {
        canSelfCheck = Boolean(text(data.word) && text(data.meaning));
        canAutoAssess = mode === 'spelling' && canSelfCheck;
        if (support?.type === 'spelling' && support.word !== data.word)
            issue('spelling-mapping-mismatch', 'learningSupport', '拼读映射与当前单词不一致，请先核对来源。');
        if (!canSelfCheck)
            issue('missing-vocabulary-reference', 'meaning', '本词缺少单词或释义，请核对来源。');
        if (mode === 'three-stage' && !text(data.example ?? data.context))
            issue('missing-vocabulary-context', 'example', '当前未提供例句，语境练习需要补充材料。', 'notice');
    }
    else if (mode === 'paper') {
        canDisplay = Boolean(input && typeof input === 'object');
        issue('paper-is-not-a-grade', 'paper', '阅读、主线自检与笔记不自动生成学习评分。', 'notice');
    }
    if (!canDisplay || issues.some(value => value.severity === 'blocking'))
        canAutoAssess = false;
    return { checkerVersion: CONTENT_CHECK_VERSION, capabilities: { canDisplay, canSelfCheck: canDisplay && canSelfCheck, canAutoAssess }, issues };
}
