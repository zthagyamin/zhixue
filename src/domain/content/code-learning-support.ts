/** Bounded source-authored function cases; no expression evaluation. */
export type CodeJSON = null | boolean | number | string | CodeJSON[] | {
    [key: string]: CodeJSON;
};
export type CodeFunctionCase = {
    id: string;
    functionName: string;
    args: CodeJSON[];
    kwargs: Record<string, CodeJSON>;
    expected: CodeJSON;
    hint?: string;
};
export type CodeLearningSupportV1 = {
    schemaVersion: 1;
    type: 'code';
    criteria?: never;
    hints?: never;
    functionNames: string[];
    cases: CodeFunctionCase[];
};
export function codeObject(raw: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || ![Object.prototype, null].includes(Object.getPrototypeOf(raw)) || required.some(key => !Object.hasOwn(raw, key)) || Object.keys(raw).some(key => ![...required, ...optional].includes(key)))
        throw Error('invalid-code-object');
    return raw as Record<string, unknown>;
}
export function codeText(raw: unknown, max = 128): string {
    if (typeof raw !== 'string' || !raw.trim() || raw.length > max)
        throw Error('invalid-code-text');
    return raw;
}
export function codeIdentifier(raw: unknown): string {
    const value = codeText(raw, 64);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value) || value.startsWith('__'))
        throw Error('invalid-code-function');
    return value;
}
export function boundedCodeJSON(raw: unknown): CodeJSON {
    let nodes = 0;
    function visit(value: unknown, depth: number): CodeJSON {
        if (++nodes > 256 || depth > 8)
            throw Error('code-json-limit');
        if (value === null || typeof value === 'boolean')
            return value;
        if (typeof value === 'number' && Number.isFinite(value))
            return value;
        if (typeof value === 'string' && value.length <= 4000)
            return value;
        if (Array.isArray(value) && value.length <= 64)
            return Array.from(value, entry => visit(entry, depth + 1));
        if (value && typeof value === 'object' && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
            const keys = Object.keys(value);
            if (keys.length > 64 || keys.some(key => key.length > 128 || ['__proto__', 'constructor', 'prototype'].includes(key)))
                throw Error('invalid-code-json-key');
            return Object.fromEntries(keys.map(key => [key, visit((value as Record<string, unknown>)[key], depth + 1)]));
        }
        throw Error('invalid-code-json');
    }
    const value = visit(raw, 0);
    if (JSON.stringify(value).length > 16000)
        throw Error('code-json-size');
    return value;
}
export function parseCodeLearningSupportV1(raw: unknown): CodeLearningSupportV1 {
    const row = codeObject(raw, ['schemaVersion', 'type', 'functionNames', 'cases']);
    if (row.schemaVersion !== 1 || row.type !== 'code')
        throw Error('unsupported-code-support');
    if (!Array.isArray(row.functionNames) || !row.functionNames.length || row.functionNames.length > 16)
        throw Error('invalid-code-functions');
    const functionNames = Array.from(row.functionNames, codeIdentifier);
    if (new Set(functionNames).size !== functionNames.length)
        throw Error('duplicate-code-function');
    if (!Array.isArray(row.cases) || !row.cases.length || row.cases.length > 32)
        throw Error('invalid-code-cases');
    const ids = new Set<string>();
    const cases = Array.from(row.cases, rawCase => {
        const entry = codeObject(rawCase, ['id', 'functionName', 'args', 'expected'], ['kwargs', 'hint']);
        const id = codeText(entry.id, 64);
        if (!/^[A-Za-z0-9:_.-]+$/.test(id) || ids.has(id))
            throw Error('invalid-code-case-id');
        ids.add(id);
        const functionName = codeIdentifier(entry.functionName);
        if (!functionNames.includes(functionName))
            throw Error('unapproved-code-function');
        if (!Array.isArray(entry.args) || entry.args.length > 20)
            throw Error('invalid-code-args');
        const args = boundedCodeJSON(entry.args) as CodeJSON[];
        const rawKwargs = entry.kwargs === undefined ? {} : entry.kwargs;
        if (!rawKwargs || typeof rawKwargs !== 'object' || Array.isArray(rawKwargs))
            throw Error('invalid-code-kwargs');
        const kwargsRow = codeObject(rawKwargs, [], Object.keys(rawKwargs));
        if (Object.keys(kwargsRow).length > 20)
            throw Error('invalid-code-kwargs');
        Object.keys(kwargsRow).forEach(codeIdentifier);
        return {
            id, functionName, args, kwargs: boundedCodeJSON(kwargsRow) as Record<string, CodeJSON>, expected: boundedCodeJSON(entry.expected), ...(entry.hint === undefined ? {} : {
                hint: codeText(entry.hint, 2000)
            })
        };
    });
    const result: CodeLearningSupportV1 = {
        schemaVersion: 1, type: 'code', functionNames, cases
    };
    if (JSON.stringify(result).length > 100000)
        throw Error('code-support-size');
    return result;
}


export function codeJSONEqual(left:CodeJSON,right:CodeJSON):boolean{
    if(left===right)return true;
    if(Array.isArray(left)||Array.isArray(right)){
        return Array.isArray(left)&&Array.isArray(right)&&left.length===right.length&&left.every((value,index)=>codeJSONEqual(value,right[index]));
    }
    if(left&&right&&typeof left==='object'&&typeof right==='object'){
        const keys=Object.keys(left);
        return keys.length===Object.keys(right).length&&keys.every(key=>Object.hasOwn(right,key)&&codeJSONEqual(left[key],right[key]));
    }
    return false;
}
