import test from 'node:test';
import assert from 'node:assert/strict';
import {listProviderModels, providerRequest} from '../src/infrastructure/ai/provider.ts';
import {createStudyAIChat} from '../src/infrastructure/ai/chat.ts';
import {createPaperReadingProvider} from '../src/infrastructure/paper-reading/provider.ts';
import {createPracticeAssistanceAi} from '../src/infrastructure/math-study/index.ts';
import {createAccountStudyPlanAi} from '../src/infrastructure/ai/plan.ts';
import {createAccountStudyQuestionAi} from '../src/infrastructure/ai/question.ts';
import {createCourseTaskAi} from '../src/infrastructure/course-ai/index.ts';
import {readProviderText} from '../src/infrastructure/ai/bounded-response.ts';
import {readFileSync} from 'node:fs';
import {resolveCourseTask, courseTaskHash} from '../src/domain/course-study/index.ts';
import {sealStudyItem} from '../app/account-study-content.ts';
import {quizBody} from './fixtures/account-study-fixtures.mjs';

const providerOptions = {key: 'synthetic-key', model: 'synthetic-model', baseUrl: 'https://fixture.example/v1', allowedOrigins: ['https://fixture.example']};
const trace = {requestId: 'synthetic-request', modelId: 'synthetic-model', promptVersion: 'v1', ruleVersion: 'v1'};
const paperInput = {unit: {title: 'Synthetic paper', goal: 'Explain', source: {sectionId: 's', paragraphs: []}}};
const signal = () => new AbortController().signal;

function chunksResponse(chunks, {status = 200, headers = {}} = {}) {
    let consumed = 0, cancelled = 0;
    const stream = new ReadableStream({
        pull(controller) {
            if (consumed === chunks.length) controller.close();
            else controller.enqueue(chunks[consumed++]);
        },
        cancel() { cancelled++; },
    }, {highWaterMark: 0});
    return {response: new Response(stream, {status, headers}), stream,
        consumed: () => consumed, cancelled: () => cancelled};
}

function oversized(size, options) {
    return chunksResponse(Array.from({length: Math.ceil(size / 4096)}, () => new Uint8Array(4096).fill(120)), options);
}

test('model list rejects oversized streamed responses before consuming their tail', async () => {
    for (const headers of [{}, {'Content-Length': '1'}]) {
        const body = oversized(320 * 1024, {headers});
        await assert.rejects(listProviderModels({...providerOptions, fetcher: async () => body.response}), /ai-model-list-empty/);
        assert.ok(body.consumed() < 80, 'stop reading as soon as the character budget is exceeded');
        assert.equal(body.cancelled(), 1);
        assert.equal(body.stream.locked, false);
    }
});

test('common upstream error bodies are bounded and retain sanitized status mapping', async () => {
    const body = oversized(80 * 1024, {status: 400});
    await assert.rejects(providerRequest({...providerOptions, fetcher: async () => body.response}, {}), /ai-provider-bad-request/);
    assert.ok(body.consumed() < 20);
    assert.equal(body.cancelled(), 1);
    assert.equal(body.stream.locked, false);
});

test('paper and nonstreaming chat apply character budgets during reading', async () => {
    for (const run of [
        fetcher => createPaperReadingProvider({...providerOptions, fetcher}).run('prepare', paperInput, trace, {maxOutputTokens: 100}, signal()),
        fetcher => createStudyAIChat({...providerOptions, fetcher}).run({context: {}, messages: []}, 100, signal()),
    ]) {
        const body = oversized(160 * 1024);
        await assert.rejects(run(async () => body.response), /paper-ai-output-limit|cloud-ai-output-invalid/);
        assert.ok(body.consumed() < 40);
        assert.equal(body.cancelled(), 1);
        assert.equal(body.stream.locked, false);
    }
});

test('practice success responses retain the existing 64 KiB byte ceiling', async () => {
    const body = oversized(80 * 1024, {headers: {'Content-Length': '1'}});
    const ai = createPracticeAssistanceAi({...providerOptions, enabled: true, fetcher: async () => body.response});
    await assert.rejects(ai.run('code-hint', {}, trace, {maxOutputTokens: 100}, signal()), /practice-ai-output-limit/);
    assert.equal(body.consumed(), 17);
    assert.equal(body.cancelled(), 1);
    assert.equal(body.stream.locked, false);
});

test('valid split UTF8 and multi-byte padding preserve model-list character semantics', async () => {
    const text = JSON.stringify({data: [{id: 'synthetic-model'}], padding: '你'.repeat(90000)});
    const encoded = new TextEncoder().encode(text);
    const body = chunksResponse([encoded.slice(0, 57), encoded.slice(57, 58), encoded.slice(58)]);
    assert.deepEqual(await listProviderModels({...providerOptions, fetcher: async () => body.response}), ['synthetic-model']);
    assert.equal(body.cancelled(), 0);
    assert.equal(body.stream.locked, false);
});

test('model-list abort cancels a pending response read even if mocked fetch ignores abort', async () => {
    const controller = new AbortController();
    let reading, cancelCount = 0, streamController, watchdog;
    const started = new Promise(resolve => { reading = resolve; });
    const stream = new ReadableStream({start(value) { streamController = value; }, pull() { reading(); }, cancel() { cancelCount++; }}, {highWaterMark: 0});
    const run = listProviderModels({...providerOptions, fetcher: async () => new Response(stream)}, controller.signal);
    try {
        await started;
        controller.abort();
        await assert.rejects(Promise.race([run, new Promise((_, reject) => {
            watchdog = setTimeout(() => reject(Error('response-watchdog')), 500);
        })]), error => error === controller.signal.reason && error.name === 'AbortError');
        assert.equal(cancelCount, 1);
        assert.equal(stream.locked, false);
    } finally {
        clearTimeout(watchdog);
        if (stream.locked) streamController.error(Error('test-cleanup'));
    }
});

test('plan, question and course reject oversized bodies at the existing 64 KiB ceiling', async () => {
    const planRequest = {planHash: 'a'.repeat(64), intent: 'standard', confirmed: true,
        candidates: [{unitId: 'course:u1', subjectId: 'course', label: 'Synthetic unit', priority: 3}], currentOptionalTaskIds: []};
    const questionItem = await sealStudyItem(quizBody());
    const support = JSON.parse(readFileSync(new URL('./fixtures/course-task-support-v2.json', import.meta.url))).cases[0].support;
    const courseBody = quizBody({schemaVersion: 2, learningSupport: support});
    courseBody.practice = {itemId: 'question-one', abilityId: 'reading-main', domain: 'course', questionType: 'recall',
        prompt: support.task.prompt, sourceLabel: 'Synthetic course'};
    const task = resolveCourseTask(await sealStudyItem(courseBody));
    const courseRequest = {schemaVersion: 1, attemptId: 'first-attempt', taskId: task.taskId, taskHash: await courseTaskHash(task),
        answerRevision: 1, evidenceRevision: 1, requestId: 'request-one'};
    for (const run of [
        fetcher => createAccountStudyPlanAi({...providerOptions, enabled: true, fetcher}).recommend(planRequest, {maxOutputTokens: 100}),
        fetcher => createAccountStudyQuestionAi({...providerOptions, enabled: true, fetcher}).run({kind: 'hint', input: ''}, questionItem, {maxOutputTokens: 100}),
        fetcher => createCourseTaskAi({...providerOptions, enabled: true, fetcher}).run(courseRequest, task, 'Synthetic answer', {maxOutputTokens: 100}),
    ]) {
        const body = oversized(80 * 1024);
        await assert.rejects(run(async () => body.response), /cloud-ai-provider-error|course-ai-provider-error/);
        assert.equal(body.consumed(), 17);
        assert.equal(body.cancelled(), 1);
        assert.equal(body.stream.locked, false);
    }
});

test('shared reader preserves every split UTF8 boundary and exact byte/character budgets', async () => {
    const text = '你好😀', encoded = new TextEncoder().encode(text);
    for (let split = 1; split < encoded.length; split++) {
        const body = chunksResponse([encoded.slice(0, split), encoded.slice(split)], {headers: {'Content-Length': '1'}});
        assert.equal(await readProviderText(body.response, {maxBytes: encoded.length, maxChars: text.length, limitError: 'synthetic-limit'}), text);
        assert.equal(body.stream.locked, false);
    }
    for (const budget of [{maxBytes: encoded.length - 1}, {maxBytes: encoded.length, maxChars: text.length - 1}]) {
        const body = chunksResponse([encoded, new Uint8Array([120])]);
        await assert.rejects(readProviderText(body.response, {...budget, limitError: 'synthetic-limit'}), /synthetic-limit/);
        assert.equal(body.cancelled(), 1);
        assert.equal(body.stream.locked, false);
    }
});

test('declared length is an early check but absent, malformed and encoded lengths do not replace byte counting', async () => {
    const early = chunksResponse([new Uint8Array([120])], {headers: {'Content-Length': '100'}});
    await assert.rejects(readProviderText(early.response, {maxBytes: 10, limitError: 'synthetic-limit'}), /synthetic-limit/);
    assert.equal(early.consumed(), 0);
    assert.equal(early.cancelled(), 1);
    assert.equal(early.stream.locked, false);
    for (const headers of [{}, {'Content-Length': '1'}, {'Content-Length': 'invalid'}, {'Content-Length': '100', 'Content-Encoding': 'gzip'}]) {
        const body = chunksResponse([new Uint8Array(11)], {headers});
        await assert.rejects(readProviderText(body.response, {maxBytes: 10, limitError: 'synthetic-limit'}), /synthetic-limit/);
        assert.equal(body.consumed(), 1);
        assert.equal(body.cancelled(), 1);
        assert.equal(body.stream.locked, false);
    }
});

test('already-aborted and late chunks cannot produce a successful bounded response', async () => {
    const already = new AbortController(); already.abort();
    const unread = chunksResponse([new Uint8Array([120])]);
    await assert.rejects(readProviderText(unread.response, {maxBytes: 10, limitError: 'synthetic-limit', signal: already.signal}),
        error => error === already.signal.reason);
    assert.equal(unread.consumed(), 0);
    assert.equal(unread.cancelled(), 1);
    assert.equal(unread.stream.locked, false);

    const controller = new AbortController(); let cancelCount = 0;
    const stream = new ReadableStream({pull(value) { controller.abort(); value.enqueue(new Uint8Array([120])); },
        cancel() { cancelCount++; }}, {highWaterMark: 0});
    await assert.rejects(readProviderText(new Response(stream), {maxBytes: 10, limitError: 'synthetic-limit', signal: controller.signal}),
        error => error === controller.signal.reason);
    assert.equal(cancelCount, 1);
    assert.equal(stream.locked, false);
});

test('overflow releases the reader even when upstream never acknowledges cancellation', async () => {
    let cancelled = 0;
    const stream = new ReadableStream({pull(value) { value.enqueue(new Uint8Array(11)); },
        cancel() { cancelled++; return new Promise(() => {}); }}, {highWaterMark: 0});
    let watchdog;
    try {
        await assert.rejects(Promise.race([
            readProviderText(new Response(stream), {maxBytes: 10, limitError: 'synthetic-limit'}),
            new Promise((_, reject) => { watchdog = setTimeout(() => reject(Error('response-watchdog')), 500); }),
        ]), /synthetic-limit/);
        assert.equal(cancelled, 1);
        assert.equal(stream.locked, false);
    } finally { clearTimeout(watchdog); }
});

test('small provider errors keep model-specific error mapping and never echo upstream text', async () => {
    const body = chunksResponse([new TextEncoder().encode(JSON.stringify({error: {code: 'model_not_found', message: '你'.repeat(5000)}}))], {status: 400});
    await assert.rejects(providerRequest({...providerOptions, fetcher: async () => body.response}, {}), error => error.message === 'ai-provider-model');
    assert.equal(body.stream.locked, false);
});

test('valid Unicode paper and chat replies retain their character-based ceilings', async () => {
    const output = {status: 'needs-improvement', reason: '你'.repeat(30000)};
    const paper = createPaperReadingProvider({...providerOptions, fetcher: async () => Response.json({
        choices: [{finish_reason: 'stop', message: {content: JSON.stringify(output)}}], padding: '你'.repeat(20000),
    })});
    assert.deepEqual((await paper.run('prepare', paperInput, trace, {maxOutputTokens: 100}, signal())).output, output);
    const content = '你'.repeat(60000);
    const chat = createStudyAIChat({...providerOptions, fetcher: async () => Response.json({
        choices: [{finish_reason: 'stop', message: {content}}],
    })});
    assert.equal((await chat.run({context: {}, messages: []}, 100, signal())).text, content);
});
