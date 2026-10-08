import type { RecallContent } from '../content/index';
// @ts-expect-error TS5097: standalone Node contracts.
import { recallReferencePrompt, isRecallEcho } from '../content/index.ts';
/** References are supplied content, never generated here. Numeric zero is a valid answer. */
export function recallReference(data: RecallContent, criteria: readonly {
    text: string;
}[] = [], fullHint?: string): string | null {
    const prompt = recallReferencePrompt(data);
    const usable = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim()) && !isRecallEcho(value, prompt);
    // Prefer a real supplied answer over a review-topic label. Filter each rubric
    // entry before joining it, so repeated questions cannot form a fake reference.
    const values = [data.explanation, data.answer === undefined ? undefined : String(data.answer), fullHint,
        criteria.map(point => point.text).filter(usable).join('\n'), data.reviewPoint];
    return values.find(usable)?.trim() ?? null;
}

/** Unvalidated source text for reading only. Unlike scoring references, echoes must not erase notes. */
export function recallMaterialText(data: RecallContent, criteria:readonly {text:string}[]=[], fullHint?:string):string|null {
    const values=[data.explanation,data.answer===undefined?undefined:String(data.answer),fullHint,criteria.map(point=>point.text).join('\n'),data.reviewPoint];
    return values.find((value):value is string=>typeof value==='string'&&Boolean(value.trim()))?.trim()??null;
}
