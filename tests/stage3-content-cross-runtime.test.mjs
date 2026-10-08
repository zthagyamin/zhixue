import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {parseLearningSupport} from '../src/domain/content/index.ts';
import {gradeCalculationStep} from '../src/domain/math-step/index.ts';

const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const calculation = fixture('stage3-calculation-support.json');
const python = process.env.PYTHON || 'python';
function runPython(script, input) {
    const reply = spawnSync(python, ['-X', 'utf8', '-c', "import sys,json;sys.path.insert(0,'companion');" + script], {
        input: JSON.stringify(input), encoding: 'utf8', windowsHide: true, timeout: 10000
    });
    assert.equal(reply.status, 0, reply.stderr || reply.error?.message);
    return JSON.parse(reply.stdout);
}
function parsedOutcome(raw, mode) {
    try {return {ok: true, value: parseLearningSupport(raw, mode)};} catch {return {ok: false};}
}
const codeSupport = expected => ({schemaVersion: 1, type: 'code', functionNames: ['f'],
    cases: [{id: 'one', functionName: 'f', args: [], expected}]});

test('Stage3 contracts normalize identically across runtimes on both shared fixture sets', () => {
    const rows = calculation.supportCases.map(row => ({...row, mode: 'calculation', input: row.support}));
    for (const name of ['stage3-code-support-contract.json', 'stage3-code-support-parity.json'])
        rows.push(...fixture(name).map(row => ({...row, mode: 'code'})));
    // V1 calculation's existing Python integer-only check remains unchanged.
    for (const row of [...rows].filter(row => row.valid && (row.mode === 'code' || row.input.schemaVersion === 2)))
        rows.push({...row, name: `${row.name}: integral floating version`, inputJson: JSON.stringify(row.input).replace(/"schemaVersion":([12])/, '"schemaVersion":$1.0')});
    const expected = rows.map(row => parsedOutcome(row.input, row.mode));
    assert.deepEqual(expected.map(row => row.ok), rows.map(row => row.valid));
    const script = "from learning_support import parse_learning_support\nout=[]\nfor row in json.load(sys.stdin):\n try: out.append({'ok':True,'value':parse_learning_support(json.loads(row['inputJson']) if 'inputJson' in row else row['input'],row['mode'])})\n except ValueError: out.append({'ok':False})\nprint(json.dumps(out,ensure_ascii=True))";
    assert.deepEqual(runPython(script, rows), expected);
});

test('JSON depth, node, UTF-16 and total size bounds agree at the observable boundaries', () => {
    let deep = 0;
    for (let index = 0; index < 9; index++) deep = [deep];
    const values = [null, '😀'.repeat(2000), '😀'.repeat(2001), [1, 2],
        Array(64).fill(0), Array(65).fill(0), deep,
        Array.from({length: 4}, () => Array(62).fill(0)),
        Array.from({length: 4}, () => Array(64).fill(0)),
        ['x'.repeat(3999), 'x'.repeat(3999), 'x'.repeat(3999), 'x'.repeat(3990)],
        ['x'.repeat(3999), 'x'.repeat(3999), 'x'.repeat(3999), 'x'.repeat(3991)],
        [1e20, 1e21, 1e-6, 1e-7, -0, 1.25e-5], '\ud800',
        {['k'.repeat(128)]: 1}, {['k'.repeat(129)]: 1}];
    // Both parsers receive JSON data; transport canonicalizes JavaScript -0 to 0.
    const supports = values.map(value => codeSupport(JSON.parse(JSON.stringify(value))));
    const expected = supports.map(raw => parsedOutcome(raw, 'code'));
    assert.deepEqual(expected.map(row => row.ok), [true, true, false, true, true, false, false, true, false, true, false, true, true, true, false]);
    const oversized = codeSupport('x'.repeat(4000));
    oversized.cases = Array.from({length: 25}, (_, index) => ({...oversized.cases[0], id: `case-${index}`}));
    supports.push(oversized);
    expected.push({ok: false});
    const script = "from learning_support import parse_learning_support\nout=[]\nfor raw in json.load(sys.stdin):\n try: out.append({'ok':True,'value':parse_learning_support(raw,'code')})\n except ValueError: out.append({'ok':False})\nprint(json.dumps(out,ensure_ascii=True))";
    assert.deepEqual(runPython(script, supports), expected);
});

test('source step diagnoses match status, source and explanation with exact decimals', () => {
    const rows = calculation.stepCases.map(row => ({answer: row.answer, support: {
        schemaVersion: 2, type: 'calculation', mode: 'numeric', variables: ['x'], domain: 'real',
        step: {stepId: 'one', prompt: 'Write the requested intermediate value.', reference: row.reference, mode: row.mode},
        ...(row.tolerance === undefined ? {} : {tolerance: row.tolerance}),
        ...(row.conditions === undefined ? {} : {conditions: row.conditions})
    }}));
    const expected = rows.map(row => gradeCalculationStep(row.answer, row.support));
    assert.deepEqual(expected.map(row => row.status), calculation.stepCases.map(row => row.status));
    const trimmed = structuredClone(rows[0]);
    trimmed.answer = '\ufeff' + trimmed.answer + '\ufeff';
    rows.push(trimmed);
    expected.push(gradeCalculationStep(trimmed.answer, trimmed.support));
    const script = "from calculation_step import grade_calculation_step;print(json.dumps([grade_calculation_step(row['answer'],row['support']) for row in json.load(sys.stdin)],ensure_ascii=True))";
    assert.deepEqual(runPython(script, rows), expected);
});
