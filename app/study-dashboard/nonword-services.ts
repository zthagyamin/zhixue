import type { PluginContext, GradePayload } from '../plugins/registry';
import type { PracticeItem } from '../companion-plan-client';
import { waitForRecallResult } from '../recall-flow-model';
type Options = {
    account: boolean;
    item: unknown;
    run: (mode: 'hint' | 'tutor' | 'recall-grade', item: unknown, answer: string) => Promise<{
        text: string;
        verdict?: string;
        rating?: string;
        matchedPointIds?: string[];
        missedPointIds?: string[];
    }>;
    evaluate: (work: () => Promise<GradePayload>, signal?: AbortSignal) => Promise<GradePayload>;
    companion?: {
        nativeCourse?: PluginContext['nativeCourse'];
        nativeMath?: PluginContext['nativeMath'];
        gradePractice: (item: PracticeItem, answer: string, signal?: AbortSignal) => Promise<GradePayload>;
    } | null;
    calculation: (item: unknown, answer: string, signal?: AbortSignal) => Promise<GradePayload>;
    hint: PluginContext['requestAiHint'];
    tutor: PluginContext['askTutor'];
};
/** Bind legacy authenticated grading services to one immutable displayed source. */
export function subjectLearningServices(options: Options): Pick<PluginContext, 'nativeCourse' | 'nativeMath' | 'requestAiHint' | 'askTutor' | 'gradeRecall' | 'gradeCalculation'> {
    return { nativeCourse: options.account ? undefined : options.companion?.nativeCourse,
        nativeMath: options.account ? undefined : options.companion?.nativeMath,
        requestAiHint: options.account ? (_, selected) => options.run('hint', options.item, selected ?? '').then(result => result.text) : options.hint,
        askTutor: options.account ? question => options.run('tutor', options.item, question).then(result => result.text) : options.tutor,
        gradeRecall: options.account ? (_, answer, signal) => options.evaluate(() => waitForRecallResult(() => options.run('recall-grade', options.item, answer).then(result => ({ correct: result.verdict === 'correct', verdict: result.verdict, rating: result.rating as 'again' | 'hard' | 'good', source: 'ai', feedback: result.text, matchedPointIds: result.matchedPointIds, missedPointIds: result.missedPointIds })), signal), signal) : options.companion ? (item, answer, signal) => options.evaluate(() => waitForRecallResult(() => options.companion!.gradePractice(item as PracticeItem, answer), signal), signal) : undefined,
        gradeCalculation: options.account ? (item, answer, signal) => options.evaluate(() => options.calculation(item, answer, signal), signal) : options.companion ? (item, answer, signal) => options.evaluate(() => options.companion!.gradePractice(item as PracticeItem, answer), signal) : undefined };
}
