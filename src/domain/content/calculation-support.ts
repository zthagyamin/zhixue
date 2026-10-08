export type CalculationSupportV1 = {
    schemaVersion: 1;
    type: 'calculation';
    mode: 'numeric' | 'symbolic';
    variables: string[];
    domain: 'real';
    tolerance?: string;
    exploration?: {
        expression: string;
        parameters: {
            id: string;
            label: string;
            min: string;
            max: string;
            step: string;
            defaultValue: string;
        }[];
    };
    criteria?: never;
    hints?: never;
};
export type CalculationStep = {
    stepId: string;
    prompt: string;
    reference: string;
    mode: 'numeric' | 'symbolic' | 'semantic';
};
export type CalculationSupportV2 = Omit<CalculationSupportV1, 'schemaVersion'> & {
    schemaVersion: 2;
    conditions?: string[];
    units?: string;
    step?: CalculationStep;
    variantMappingId?: string;
};
export type CalculationSupport = CalculationSupportV1 | CalculationSupportV2;
function closed(value: unknown, keys: string[]): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !keys.includes(k)))
    throw Error('invalid-calculation-support'); return value as Record<string, unknown>; }
function numeric(value: unknown) { if (typeof value !== 'string' || !/^-?(?:\d{1,6})(?:\.\d{1,6})?$/.test(value) || !Number.isFinite(Number(value)))
    throw Error('invalid-calculation-decimal'); return Number(value); }
function parseCalculationSupportV1(raw: unknown): CalculationSupportV1 {
    const v = closed(raw, ['schemaVersion', 'type', 'mode', 'variables', 'domain', 'tolerance', 'exploration']);
    if (v.schemaVersion !== 1 || v.type !== 'calculation' || !['numeric', 'symbolic'].includes(String(v.mode)) || v.domain !== 'real' || !Array.isArray(v.variables) || v.variables.length > 4 || v.variables.some(x => typeof x !== 'string' || !/^[a-zA-Z]$/.test(x)) || new Set(v.variables).size !== v.variables.length)
        throw Error('invalid-calculation-support');
    if (v.tolerance !== undefined && (numeric(v.tolerance) < 0 || numeric(v.tolerance) > 1))
        throw Error('invalid-calculation-tolerance');
    if (v.exploration !== undefined) {
        const e = closed(v.exploration, ['expression', 'parameters']);
        if (typeof e.expression !== 'string' || !e.expression.trim() || e.expression.length > 512 || !Array.isArray(e.parameters) || !e.parameters.length || e.parameters.length > 4)
            throw Error('invalid-calculation-exploration');
        const ids = new Set();
        for (const rawP of e.parameters) {
            const p = closed(rawP, ['id', 'label', 'min', 'max', 'step', 'defaultValue']);
            if (typeof p.id !== 'string' || !v.variables.includes(p.id) || ids.has(p.id) || typeof p.label !== 'string' || !p.label.trim() || p.label.length > 80)
                throw Error('invalid-calculation-parameter');
            ids.add(p.id);
            const min = numeric(p.min), max = numeric(p.max), step = numeric(p.step), def = numeric(p.defaultValue);
            if (min >= max || step <= 0 || step > max - min || def < min || def > max || (max - min) / step > 10000)
                throw Error('invalid-calculation-range');
        }
        if (ids.size !== v.variables.length)
            throw Error('missing-calculation-parameter');
    }
    return structuredClone(v) as CalculationSupportV1;
}

function boundedText(raw: unknown, maximum: number): string {
    // eslint-disable-next-line no-control-regex -- source text excludes unsafe control characters.
    if (typeof raw !== 'string' || !raw.trim() || raw.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(raw))
        throw Error('invalid-calculation-text');
    return raw;
}
function identifier(raw: unknown): string {
    const value = boundedText(raw, 120);
    if (!/^[a-zA-Z0-9:_.-]+$/.test(value)) throw Error('invalid-calculation-id');
    return value;
}
function normalized(value: string): string {
    return value.trim().replace(/\s+/gu, ' ').toLowerCase();
}
function v2Object(raw: unknown, keys: string[], required = keys): Record<string, unknown> {
    const value = closed(raw, keys);
    if (![Object.prototype, null].includes(Object.getPrototypeOf(value)) || required.some(key => !Object.hasOwn(value, key)))
        throw Error('invalid-calculation-support');
    return value;
}
/** V1 remains closed and unchanged. V2 is an additive, separately versioned contract. */
export function parseCalculationSupport(raw: unknown): CalculationSupport {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !('schemaVersion' in raw) || raw.schemaVersion !== 2)
        return parseCalculationSupportV1(raw);
    const v = v2Object(raw, ['schemaVersion', 'type', 'mode', 'variables', 'domain', 'tolerance', 'exploration', 'conditions', 'units', 'step', 'variantMappingId'], ['schemaVersion', 'type', 'mode', 'variables', 'domain']);
    if (typeof v.mode !== 'string' || !['numeric', 'symbolic'].includes(v.mode)
        || !Array.isArray(v.variables) || Array.from(v.variables).some(value => typeof value !== 'string' || !/^[a-zA-Z]$/.test(value)))
        throw Error('invalid-calculation-support');
    const base = Object.fromEntries(Object.entries(v).filter(([key]) => !['conditions', 'units', 'step', 'variantMappingId'].includes(key)));
    parseCalculationSupportV1({...base, schemaVersion: 1});
    if (v.exploration !== undefined) {
        const exploration = v2Object(v.exploration, ['expression', 'parameters']);
        for (const parameter of exploration.parameters as unknown[])
            v2Object(parameter, ['id', 'label', 'min', 'max', 'step', 'defaultValue']);
    }
    if (v.conditions !== undefined) {
        if (!Array.isArray(v.conditions) || v.conditions.length > 8) throw Error('invalid-calculation-conditions');
        const entries = Array.from(v.conditions, value => normalized(boundedText(value, 300)));
        if (new Set(entries).size !== entries.length) throw Error('duplicate-calculation-condition');
    }
    if (v.units !== undefined) boundedText(v.units, 80);
    if (v.variantMappingId !== undefined) identifier(v.variantMappingId);
    if (v.step !== undefined) {
        const step = v2Object(v.step, ['stepId', 'prompt', 'reference', 'mode']);
        identifier(step.stepId);
        const prompt = boundedText(step.prompt, 512), reference = boundedText(step.reference, 512);
        if (normalized(prompt) === normalized(reference) || typeof step.mode !== 'string' || !['numeric', 'symbolic', 'semantic'].includes(step.mode))
            throw Error('invalid-calculation-step');
    }
    return structuredClone(v) as CalculationSupportV2;
}
