import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHooks, loader, nodes, text, button, deferred, tick } from './helpers/causal-harness.mjs';
import { resolveCourseTask, deterministicCourseDiagnostic, validateCourseDiagnostic } from '../src/domain/course-study/index.ts';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/course-study-diagnostics-v1.json', import.meta.url)));
const sourceItem = support => ({ schemaVersion: 2, kind: 'practice', eventKind: 'due', contentHash: 'a'.repeat(64),
    learningSupport: support, practice: { questionType: support.type, prompt: support.task.prompt, domain: 'course' } });
function setup({ kind = 'definition', status = 'correct', mode = 'recall', purpose = 'first', submitted = false,
    selection = 'multiple', self = true, mapped = true, seedEvidence = false, feedback, caseId } = {}) {
    const authored = caseId ? fixture.cases.find(row => row.id === caseId) : null;
    if (caseId) assert.ok(authored, 'the authored outcome must exist');
    if (authored) status = {...fixture.diagnosticBase, ...authored.diagnosticOverrides}.status;
    const support = structuredClone(authored ? fixture.supports[authored.supportId] :
        mode === 'quiz' ? fixture.quizSupport : fixture.supports[status === 'partial' ? 'partial' : kind]);
    if (mode === 'quiz') {
        support.selection = selection;
        if (selection === 'single') support.correctOptionIds = ['c'];
    }
    const task = resolveCourseTask(sourceItem(support));
    let original = submitted ? mode === 'quiz' ? '["a"]' : '已保存原答' : '', evidence = null;
    const calls = [], grades = [], fields = { answer: '', courseSelection: [] };
    const base = authored ?? fixture.cases.find(row => row.id === (status === 'correct' ? kind : status === 'undetermined' ? 'unknown' : status));
    const diagnostic = () => mode === 'quiz' ? deterministicCourseDiagnostic(task, original) :
        { ...fixture.diagnosticBase, ...base.diagnosticOverrides, status,
            ...(feedback === undefined ? {} : { feedback }) };
    const makeEvidence = value => ({ schemaVersion: 1, attemptId: 'attempt', taskId: task.taskId,
        taskHash: 'b'.repeat(64), answerRevision: 2, diagnosticHash: 'd'.repeat(64), diagnostic: value });
    const course = { task, originalAnswer: () => original, evidence: () => evidence,
        evaluate: async signal => { calls.push(['evaluate', signal]); evidence = makeEvidence(diagnostic()); return evidence; },
        remediationTaskId: () => mapped && status !== 'correct' ? 'mapped-child' : null,
        ...(self ? { selfAssess: async value => { calls.push(['self', value]); evidence = makeEvidence({ ...fixture.diagnosticBase,
            status: value, source: 'self-assess', matchedPointIds: [], pointEvidence: [], errorPointIds: [], missedPointIds: [] }); return evidence; } } : {}) };
    const lifecycle = { course, attemptId: 'attempt', ready: true, submitted, purpose, intent: 'review',
        submit: async answer => { calls.push(['submit', answer]); original = answer; lifecycle.submitted = true; },
        assess: () => { throw Error('component cannot own evaluation'); },
        waitForReview: async reason => { calls.push(['pending', reason]); },
        continuePending: async () => { calls.push(['continuePending']); },
        startRemediation: async () => { calls.push(['startRemediation']); },
        finishRemediation: async () => { calls.push(['finishRemediation']); } };
    if (seedEvidence) evidence = makeEvidence(diagnostic());
    const draft = { read: (field, fallback) => fields[field] ?? fallback,
        write: (field, value) => { fields[field] = value; calls.push(['write', field, value]); return true; } };
    const hooks = createHooks(), load = loader(hooks.api), Component = load('src/features/course-study/interaction.tsx').CourseInteraction;
    const props = { lifecycle, draft, onGrade: async value => { grades.push(value); },
        renderMath: value => ({ type: 'math-fixture', props: { children: value } }) };
    const render = (replacement = props) => { const view = hooks.render(replacement); hooks.flush(); return view; };
    hooks.mount(Component, props); hooks.flush();
    const input = value => { const node = [...nodes(hooks.view())].find(n => n.type === 'textarea'); node.props.onChange({ target: { value } }); render(); };
    const click = async label => { const target = button(hooks.view(), label); assert.ok(target, label); await target.props.onClick(); await tick(); render(); };
    return { hooks, render, props, calls, grades, fields, course, lifecycle, task, input, click,
        setEvidence: value => { evidence = value; }, makeEvidence, original: () => original };
}
for (const row of fixture.cases.filter(value => value.id.startsWith('matrix-'))) {
    test(`actual four-outcome flow: ${row.id}`, async () => {
        const h = setup({caseId:row.id});
        const diagnostic = {...fixture.diagnosticBase, ...row.diagnosticOverrides};
        assert.deepEqual(validateCourseDiagnostic(diagnostic, h.task, row.answer), diagnostic);
        assert.equal(h.task.kind, fixture.supports[row.supportId].task.kind);
        h.input(row.answer); await h.click('提交回答');
        assert.equal(h.original(), row.answer);
        assert.equal([...nodes(h.hooks.view())].find(node => node.type === 'textarea').props.value, row.answer);
        assert.deepEqual(h.calls.filter(call => ['submit','evaluate','self'].includes(call[0]))
            .map(call => call[0]), ['submit','evaluate']);
        if (diagnostic.status === 'undetermined') {
            assert.ok(text(h.hooks.view()).includes('待核对'));
            assert.ok(!button(h.hooks.view(), '继续'));
            await h.click('保留待核对并继续');
            assert.deepEqual(h.grades, []);
            assert.ok(h.calls.some(call => call[0] === 'continuePending'));
        } else {
            if (diagnostic.status !== 'correct') assert.ok(button(h.hooks.view(), '针对这个问题补练'));
            await h.click('继续');
            assert.deepEqual(h.grades, [{correct:'good', partial:'hard', incorrect:'again'}[diagnostic.status]]);
        }
        h.hooks.unmount();
    });
}
function defaultVisibleText(value) {
    if (Array.isArray(value)) return value.map(defaultVisibleText).join('');
    if (value?.type === 'details' && !value.props.open)
        return defaultVisibleText([value.props.children].flat().find(child => child?.type === 'summary'));
    return value?.props ? defaultVisibleText(value.props.children) : text(value);
}

test('question and essential conditions stay visible while scope is optional',()=>{
    const h=setup({kind:'conditions'}),visible=defaultVisibleText(h.hooks.view());
    assert.ok(visible.includes(h.task.prompt));
    for(const condition of h.task.conditions) assert.ok(visible.includes(condition));
    assert.ok(!visible.includes(h.task.scope));
    assert.ok(text(h.hooks.view()).includes(h.task.scope));
    assert.ok(!visible.includes('作答范围'));
});

test('resolved course feedback shows its short explanation before opening reference', () => {
    for (const status of ['correct', 'partial', 'incorrect']) {
        const feedback = '核对说明：你对适用条件的解释与当前题目要求一致。';
        const h = setup({ status, submitted: true, seedEvidence: true, feedback });
        assert.ok(defaultVisibleText(h.hooks.view()).includes(feedback), status);
        assert.ok(!defaultVisibleText(h.hooks.view()).includes(h.task.sources[0].excerpt));
        const reference = [...nodes(h.hooks.view())].find(node => node.type === 'details' && text(node.props.children[0]) === '查看来源依据与完整参考');
        assert.equal(reference.props.open, false, 'full reference remains optional');
    }
});

test('long course explanation exposes prose while keeping full math code and reference optional', () => {
    const prose = '漏掉输入触发条件会改变这条需求的含义。需要对照题目给定的上下文，说明输入发生时系统如何响应。'.repeat(15);
    const feedback = prose + '\n\n$$x^2+1$$\n```python\nassert value < limit\n```';
    const h = setup({ submitted: true, seedEvidence: true, feedback });
    const visible = defaultVisibleText(h.hooks.view());
    assert.ok(visible.includes('漏掉输入触发条件会改变这条需求的含义'));
    assert.ok(!visible.includes('assert value < limit'));
    const disclosures = [...nodes(h.hooks.view())].filter(node => node.type === 'details');
    assert.ok(disclosures.some(node => text(node).includes('$$x^2+1$$') && text(node).includes('assert value < limit')));
    assert.ok(disclosures.every(node => !node.props.open));
});
for (const kind of ['definition', 'steps', 'comparison', 'conditions', 'application']) {
    test(`actual ${kind} component preserves source metadata, scope and submitted original`, async () => {
        const h = setup({ kind });
        const before = text(h.hooks.view());
        assert.ok(before.includes(h.task.sources[0].label));
        assert.ok(before.includes(h.task.sources[0].locator));
        assert.ok(before.includes(h.task.scope));
        for (const condition of h.task.conditions) assert.ok(before.includes(condition));
        assert.ok(!before.includes(h.task.sources[0].excerpt), 'source excerpt must not become a pre-answer hint');
        assert.ok(!before.includes('Synthetic paraphrase alignment.'));
        h.input('保留这一份原答');
        await h.click('提交回答');
        assert.equal(h.calls.find(row => row[0] === 'submit')[1], '保留这一份原答');
        assert.deepEqual(h.calls.filter(row => ['submit', 'evaluate'].includes(row[0])).map(row => row[0]), ['submit', 'evaluate']);
        const answer = [...nodes(h.hooks.view())].find(n => n.type === 'textarea');
        assert.equal(answer.props.readOnly, true);
        assert.equal(answer.props.value, '保留这一份原答');
        assert.ok(text(h.hooks.view()).includes('本次回答符合要求'));
        await h.click('继续');
        assert.deepEqual(h.grades, ['good']);
    });
}
for (const [status, expected] of [['partial', 'hard'], ['incorrect', 'again']]) {
    test(`${status} shows source-authored key gap and continuation maps ${expected}`, async () => {
        const h = setup({ status }); h.input('原答'); await h.click('提交回答');
        assert.ok(text(h.hooks.view()).includes(status === 'partial' ? '待补要点' : '需要修正'));
        await h.click('继续'); assert.deepEqual(h.grades, [expected]);
    });
}
test('mandatory omission precedes substantive error without invented background', async () => {
    const h = setup({ status: 'partial', seedEvidence: true, submitted: true });
    const diagnostic = { ...fixture.diagnosticBase, status: 'partial', missedPointIds: ['extra'], errorPointIds: ['key'] };
    h.setEvidence(h.makeEvidence(diagnostic));
    // A fresh scope restores the authoritative matching record.
    h.props.lifecycle = { ...h.lifecycle, course: { ...h.course } }; h.render(h.props); h.render(h.props);
    const key = [...nodes(h.hooks.view())].find(n => n.props.className === 'course-study-key');
    assert.ok(text(key).includes(h.task.criteria.find(row => row.id === 'extra').text));
    assert.ok(!text(key).includes(h.task.criteria.find(row => row.id === 'key').text));
});
test('single and multiple choice retain stable selection field and require explicit submission', async () => {
    for (const selection of ['single', 'multiple']) {
        const h = setup({ mode: 'quiz', selection });
        let inputs = [...nodes(h.hooks.view())].filter(n => n.type === 'input');
        assert.equal(inputs[0].props.type, selection === 'single' ? 'radio' : 'checkbox');
        inputs[0].props.onChange(); h.render();
        inputs = [...nodes(h.hooks.view())].filter(n => n.type === 'input');
        inputs[2].props.onChange(); h.render();
        assert.deepEqual(h.fields.courseSelection, selection === 'single' ? ['c'] : ['a', 'c']);
        assert.equal(h.calls.filter(row => row[0] === 'submit').length, 0);
        assert.ok(h.calls.filter(row => row[0] === 'write').every(row => row[1] === 'courseSelection'));
        const group = [...nodes(h.hooks.view())].find(n => n.type === 'fieldset');
        assert.equal(group.props.role, selection === 'single' ? 'radiogroup' : 'group');
        await h.click('提交回答');
        assert.equal(h.original(), selection === 'single' ? '["c"]' : '["a","c"]');
        assert.equal([...nodes(h.hooks.view())].find(n => n.type === 'fieldset').props.disabled, true);
    }
});
test('textarea newline remains writing; Ctrl Enter submits once', async () => {
    const h = setup(); h.input('first\nsecond');
    const field = [...nodes(h.hooks.view())].find(n => n.type === 'textarea');
    let prevented = 0;
    field.props.onKeyDown({ key: 'Enter', preventDefault: () => prevented++ });
    assert.equal(prevented, 0); assert.equal(h.calls.filter(row => row[0] === 'submit').length, 0);
    field.props.onKeyDown({ key: 'Enter', ctrlKey: true, preventDefault: () => prevented++ });
    await tick(); h.render(); assert.equal(prevented, 1); assert.equal(h.original(), 'first\nsecond');
});

test('expanded choice feedback identifies every wrong and missing option with its authored explanation', async () => {
    const h = setup({mode: 'quiz'});
    const inputs = [...nodes(h.hooks.view())].filter(n => n.type === 'input');
    const wrong = h.task.options.find(option => !h.task.correctOptionIds.includes(option.optionId));
    inputs[h.task.options.indexOf(wrong)].props.onChange(); h.render();
    await h.click('提交回答');
    const diagnostic = h.course.evidence().diagnostic;
    assert.ok(diagnostic.wrongOptionIds.length > 0 && diagnostic.missingOptionIds.length > 0);
    const details = [...nodes(h.hooks.view())].find(n => n.type === 'details' && text(n.props.children[0]) === '查看来源依据与完整参考');
    const feedback = [...nodes(details)].find(n => n.props['aria-label'] === '错选与漏选');
    assert.ok(feedback, 'complete feedback must connect explanations to actual option text');
    for (const id of [...diagnostic.wrongOptionIds, ...diagnostic.missingOptionIds]) {
        const option = h.task.options.find(option => option.optionId === id);
        assert.ok(text(feedback).includes(option.text));
        assert.ok(text(feedback).includes(option.explanation));
    }
    assert.ok(text(feedback).includes('错选') && text(feedback).includes('漏选'));
    assert.equal(details.props.open, false, 'the complete list remains optional');
    assert.deepEqual(h.grades, []);
});
test('duplicate submission uses one durable submission before evaluation starts', async () => {
    const h = setup(), gate = deferred(); h.input('exact original');
    const submit = h.lifecycle.submit;
    h.lifecycle.submit = async answer => { await gate.promise; return submit(answer); };
    const target = button(h.hooks.view(), '提交回答');
    target.props.onClick(); target.props.onClick(); await tick();
    assert.equal(h.calls.filter(row => row[0] === 'evaluate').length, 0);
    gate.resolve(); await tick(); h.render();
    assert.equal(h.calls.filter(row => row[0] === 'submit').length, 1);
    assert.equal(h.calls.filter(row => row[0] === 'evaluate').length, 1);
});
test('failed original save preserves editable input and never evaluates or grades', async () => {
    const h = setup(); h.input('unsaved original'); h.lifecycle.submit = async () => { throw Error('storage failed'); };
    await h.click('提交回答');
    assert.equal([...nodes(h.hooks.view())].find(n => n.type === 'textarea').props.value, 'unsaved original');
    assert.equal([...nodes(h.hooks.view())].find(n => n.type === 'textarea').props.readOnly, false);
    assert.equal(h.calls.filter(row => row[0] === 'evaluate').length, 0);
    assert.ok(text(h.hooks.view()).includes('当前输入保留')); assert.deepEqual(h.grades, []);
});
test('AI unavailable becomes pending with original-only retry and explicit continuation', async () => {
    const h = setup(); h.input('immutable original'); h.course.evaluate = async () => { throw Error('AI off'); };
    await h.click('提交回答');
    assert.ok(text(h.hooks.view()).includes('待核对'));
    assert.ok(text(h.hooks.view()).includes('答案已保存，可稍后核对'));
    assert.ok(!button(h.hooks.view(), '继续')); assert.deepEqual(h.grades, []);
    await h.click('重试核对原答案');
    assert.equal(h.calls.filter(row => row[0] === 'submit').length, 1);
    await h.click('保留待核对并继续');
    assert.ok(h.calls.some(row => row[0] === 'continuePending')); assert.deepEqual(h.grades, []);
});
test('undetermined and missing matching evidence do not produce actionable grade', async () => {
    for (const missing of [false, true]) {
        const h = setup({ status: 'undetermined' }); h.input('original');
        if (missing) h.course.evaluate = async () => h.makeEvidence({ ...fixture.diagnosticBase });
        await h.click('提交回答');
        assert.ok(text(h.hooks.view()).includes('待核对')); assert.ok(!button(h.hooks.view(), '继续'));
        assert.deepEqual(h.grades, []); assert.ok(h.calls.some(row => row[0] === 'pending'));
    }
});
test('cancellation aborts evaluation and late result cannot reveal feedback or self assess', async () => {
    const h = setup(), gate = deferred(); let signal;
    h.input('original'); h.course.evaluate = async input => { signal = input; return gate.promise; };
    button(h.hooks.view(), '提交回答').props.onClick(); await tick(); h.render();
    await h.click('停止核对'); assert.equal(signal.aborted, true);
    gate.resolve(h.makeEvidence(fixture.diagnosticBase)); await tick(); h.render();
    assert.ok(text(h.hooks.view()).includes('待核对'));
    assert.ok(!text(h.hooks.view()).includes('本次回答符合要求'));
    assert.equal(h.calls.filter(row => row[0] === 'self').length, 0); assert.deepEqual(h.grades, []);
});
test('cancel during submission waits for reliable original before pending, and never evaluates', async () => {
    const h = setup(), gate = deferred(); const submit = h.lifecycle.submit;
    h.lifecycle.submit = async answer => { await gate.promise; return submit(answer); }; h.input('actual entered');
    button(h.hooks.view(), '提交回答').props.onClick(); await tick(); h.render();
    const stop = button(h.hooks.view(), '停止核对'); stop.props.onClick(); stop.props.onClick(); await tick();
    assert.equal(h.calls.filter(row => row[0] === 'pending').length, 0);
    gate.resolve(); await tick(); h.render();
    assert.deepEqual(h.calls.filter(row => ['submit', 'pending'].includes(row[0])).map(row => row[0]), ['submit', 'pending']);
    assert.equal(h.calls.filter(row => row[0] === 'pending').length, 1, 'repeated cancel is one pending operation');
    assert.equal(h.calls.filter(row => row[0] === 'evaluate').length, 0);
});
test('unmount and attempt switch discard old evaluation and feedback', async () => {
    for (const unmount of [false, true]) {
        const h = setup(), gate = deferred(); h.input('old answer'); h.course.evaluate = () => gate.promise;
        button(h.hooks.view(), '提交回答').props.onClick(); await tick(); h.render();
        if (unmount) h.hooks.unmount();
        else { h.props.lifecycle = { ...h.lifecycle, attemptId: 'new-attempt', submitted: false }; h.render(h.props); h.render(h.props); }
        gate.resolve(h.makeEvidence(fixture.diagnosticBase)); await tick();
        if (!unmount) { h.render(h.props); assert.ok(!text(h.hooks.view()).includes('本次回答符合要求')); }
        assert.deepEqual(h.grades, []);
    }
});
test('explicit forgotten gesture saves actual entered original then records self-assess', async () => {
    const h = setup(); h.input('我只记得一点'); await h.click('我忘了，查看关键参考');
    assert.deepEqual(h.calls.filter(row => ['submit', 'self'].includes(row[0])), [['submit', '我只记得一点'], ['self', 'incorrect']]);
    assert.equal(h.calls.filter(row => row[0] === 'evaluate').length, 0);
    assert.ok(text(h.hooks.view()).includes('自评')); assert.deepEqual(h.grades, []);
    const unsupported = setup({ self: false }); assert.ok(!button(unsupported.hooks.view(), '我忘了，查看关键参考'));
});
test('restoration uses persisted original and matching diagnostic, not editable draft or wrong attempt', () => {
    const h = setup({ submitted: true, seedEvidence: true });
    assert.equal([...nodes(h.hooks.view())].find(n => n.type === 'textarea').props.value, '已保存原答');
    assert.ok(text(h.hooks.view()).includes('本次回答符合要求'));
    h.setEvidence({ ...h.makeEvidence(fixture.diagnosticBase), attemptId: 'different' });
    h.props.lifecycle = { ...h.lifecycle, course: { ...h.course } }; h.render(h.props); h.render(h.props);
    assert.ok(!button(h.hooks.view(), '继续')); assert.ok(text(h.hooks.view()).includes('待核对'));
});
test('mapped remediation delegates selection to host and fallback clearly retries original', async () => {
    for (const mapped of [false, true]) {
        const h = setup({ status: 'incorrect', mapped }); h.input('first answer'); await h.click('提交回答');
        await h.click(mapped ? '针对这个问题补练' : '收起解释，在原题再试');
        assert.deepEqual(h.calls.find(row => row[0] === 'startRemediation'), ['startRemediation']);
        assert.deepEqual(h.grades, []);
        if (!mapped) assert.ok(text(h.hooks.view()).includes('原题'));
    }
});
test('guided saves guidance through host, child continues through finish without a new grade', async () => {
    const guided = setup({ purpose: 'guided', status: 'incorrect' }); guided.input('guided'); await guided.click('提交回答');
    assert.ok(!button(guided.hooks.view(), '针对这个问题补练'));
    await guided.click('保存本次引导结果'); assert.deepEqual(guided.grades, ['again']);
    const child = setup({ purpose: 'remediation' }); child.input('retry'); await child.click('提交回答');
    assert.ok(text(child.hooks.view()).includes('本次补练通过'));
    assert.ok(!text(child.hooks.view()).includes('掌握'));
    await child.click('继续'); assert.deepEqual(child.grades, []);
    assert.deepEqual(child.calls.find(row => row[0] === 'finishRemediation'), ['finishRemediation']);
});
test('actual shared renderer preserves math and code in prompt, criteria and feedback', async () => {
    const h = setup(); h.task.prompt = '请解释 $x^2$\n```python\nprint(x)\n```';
    h.task.criteria[0].text = '$$x^2$$\n```python\nprint(x)\n```';
    h.render();
    assert.ok([...nodes(h.hooks.view())].some(n => n.type === 'pre' && text(n).includes('print(x)')));
    assert.ok([...nodes(h.hooks.view())].some(n => n.type === 'math-fixture' && text(n).includes('$x^2$')));
    h.input('answer'); await h.click('提交回答');
    assert.ok([...nodes(h.hooks.view())].some(n => n.type === 'math-fixture' && text(n).includes('$$x^2$$')));
    assert.ok([...nodes(h.hooks.view())].filter(n => n.type === 'pre').length >= 2);
});
test('expanded reference shows identical parent criteria once and preserves a distinct child answer', () => {
    const parent = setup({ submitted: true, seedEvidence: true });
    const canonical = parent.task.criteria.map(point => point.text).join('\n');
    assert.equal(parent.task.answer, canonical, 'fixture exercises the resolved parent reference');
    const referenceBlocks = h => {
        const details = [...nodes(h.hooks.view())].find(n => n.type === 'details' && text(n.props.children[0]) === '查看来源依据与完整参考');
        return [...nodes(details)].filter(n => n.type === 'div' && n.props.className === 'nonword-text');
    };
    assert.equal(referenceBlocks(parent).filter(n => text(n) === canonical).length, 1);
    const child = setup({ purpose: 'remediation', submitted: true, seedEvidence: true });
    child.task.answer = '补练独立参考：$x^2$\n```python\nprint(x)\n```';
    child.render();
    const blocks = referenceBlocks(child);
    assert.equal(blocks.filter(n => text(n) === canonical).length, 1);
    const childReference = blocks.filter(n => text(n).startsWith('补练独立参考：$x^2$'));
    assert.equal(childReference.length, 1);
    assert.ok(text(childReference[0]).includes('print(x)'));
    assert.ok([...nodes(child.hooks.view())].some(n => n.type === 'pre' && text(n).includes('print(x)')));
});
test('resolved continuation duplicates invoke host grade once and changed matching evidence blocks grade', async () => {
    const h = setup(), gate = deferred(); h.input('answer'); await h.click('提交回答');
    h.props.onGrade = async value => { h.grades.push(value); await gate.promise; }; h.render();
    const target = button(h.hooks.view(), '继续'); target.props.onClick(); target.props.onClick(); await tick();
    assert.deepEqual(h.grades, ['good']); gate.resolve(); await tick();
    const stale = setup(); stale.input('answer'); await stale.click('提交回答');
    stale.setEvidence({ ...stale.makeEvidence(fixture.diagnosticBase), diagnosticHash: 'changed' });
    await stale.click('继续'); assert.deepEqual(stale.grades, []); assert.ok(text(stale.hooks.view()).includes('请重试'));
});
test('quiz Enter explicitly submits the selected stable IDs with accessible native focus', async () => {
    const h = setup({ mode: 'quiz' });
    const first = [...nodes(h.hooks.view())].find(n => n.type === 'input'); first.props.onChange(); h.render();
    const selected = [...nodes(h.hooks.view())].find(n => n.type === 'input'); let prevented = false;
    selected.props.onKeyDown({ key: 'Enter', preventDefault: () => { prevented = true; } });
    await tick(); h.render();
    assert.equal(prevented, true); assert.equal(h.original(), '["a"]');
    assert.ok(text(h.hooks.view()).includes('漏选'));
});
test('a diagnostic invalidated by the port is hidden on rerender and cannot continue grading', async () => {
    const h = setup(); h.input('answer'); await h.click('提交回答');
    h.setEvidence(null); h.render();
    assert.ok(!text(h.hooks.view()).includes('本次回答符合要求')); assert.ok(!button(h.hooks.view(), '继续'));
    assert.ok(text(h.hooks.view()).includes('待核对')); assert.deepEqual(h.grades, []);
});
test('self assessment never labels an unproven child mapping as targeted remediation', async () => {
    const h = setup({ status: 'incorrect', mapped: true }); h.input('forgot'); await h.click('我忘了，查看关键参考');
    assert.ok(!button(h.hooks.view(), '针对这个问题补练'));
    assert.ok(button(h.hooks.view(), '收起解释，在原题再试'));
    assert.ok(text(h.hooks.view()).includes('原题'));
});
