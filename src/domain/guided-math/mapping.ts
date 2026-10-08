// @ts-expect-error TS5097: standalone Node contracts.
import {parseCalculationSupport, type CalculationSupport} from '../content/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {defineMath, MATH_TEMPLATES, type TemplateId} from './templates.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {createMathVariant, type MathVariant, type ParentBinding} from './variant.ts';

/** This record is supplied by approved authority. Structural validity is not approval. */
export type MathVariantMappingV1 = ParentBinding & {
    schemaVersion: 1;
    mappingId: string;
    templateVersion: 1;
    templateId: TemplateId;
    sourceConditions: string[];
    parameters: Record<string, number>;
};
export type MappedMathVariantResult =
    | {status: 'available'; variant: MathVariant; mappingId: string; sourceConditions: string[]}
    | {status: 'unavailable'; reason: 'missing-mapping' | 'mapping-reference-mismatch' | 'parent-mismatch' | 'invalid-mapping'};

function record(raw: unknown, keys: readonly string[]): Record<string, unknown> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))
        || keys.some(key => !Object.hasOwn(raw, key)) || Object.keys(raw).some(key => !keys.includes(key)))
        throw Error('invalid-math-variant-mapping');
    return raw as Record<string, unknown>;
}
function text(raw: unknown, maximum: number): string {
    // eslint-disable-next-line no-control-regex -- trusted source text excludes unsafe controls.
    if (typeof raw !== 'string' || !raw.trim() || raw.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(raw))
        throw Error('invalid-math-variant-mapping-text');
    return raw;
}
/** Closed protocol and existing template parameters only; no caller expected answer. */
export function parseMathVariantMapping(raw: unknown): MathVariantMappingV1 {
    const v = record(raw, ['schemaVersion', 'mappingId', 'parentItemKey', 'parentContentHash', 'hashKind', 'templateVersion', 'templateId', 'sourceConditions', 'parameters']);
    if (v.schemaVersion !== 1 || v.templateVersion !== 1 || !MATH_TEMPLATES.some(template => template.id === v.templateId))
        throw Error('unsupported-math-variant-mapping');
    if (!/^[a-zA-Z0-9:_.-]+$/.test(text(v.mappingId, 120))) throw Error('invalid-math-variant-mapping-id');
    text(v.parentItemKey, 1000);
    text(v.parentContentHash, 500);
    if (typeof v.hashKind !== 'string' || !['content', 'visible-snapshot'].includes(v.hashKind)) throw Error('invalid-math-variant-mapping-parent');
    if (!Array.isArray(v.sourceConditions) || v.sourceConditions.length > 8) throw Error('invalid-math-variant-mapping-conditions');
    const conditions = Array.from(v.sourceConditions, entry => text(entry, 300).trim().replace(/\s+/gu, ' ').toLowerCase());
    if (new Set(conditions).size !== conditions.length) throw Error('duplicate-math-variant-mapping-condition');
    if (!v.parameters || typeof v.parameters !== 'object' || Array.isArray(v.parameters)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(v.parameters))) throw Error('invalid-template-parameters');
    defineMath(v.templateId as TemplateId, v.parameters as Record<string, number>);
    return structuredClone(v) as MathVariantMappingV1;
}

/** Caller resolves approved mapping; no topic/length inference and no alternate template. */
export async function createMappedMathVariant(input: {
    parent: ParentBinding;
    support: CalculationSupport;
    mapping?: unknown;
    seed: number;
}): Promise<MappedMathVariantResult> {
    try {
        const support = parseCalculationSupport(input.support);
        if (support.schemaVersion !== 2 || !support.variantMappingId || input.mapping === undefined)
            return {status: 'unavailable', reason: 'missing-mapping'};
        const mapping = parseMathVariantMapping(input.mapping);
        if (mapping.mappingId !== support.variantMappingId)
            return {status: 'unavailable', reason: 'mapping-reference-mismatch'};
        const parent = input.parent;
        if (!parent || mapping.parentItemKey !== parent.parentItemKey || mapping.parentContentHash !== parent.parentContentHash || mapping.hashKind !== parent.hashKind)
            return {status: 'unavailable', reason: 'parent-mismatch'};
        const variant = await createMathVariant({parent, templateId: mapping.templateId, seed: input.seed, parameters: mapping.parameters});
        return {status: 'available', variant, mappingId: mapping.mappingId, sourceConditions: mapping.sourceConditions};
    } catch {
        return {status: 'unavailable', reason: 'invalid-mapping'};
    }
}
