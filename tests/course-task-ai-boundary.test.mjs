import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAccountStudyQuestionAi } from '../app/account-study-question-ai.ts';
import { sealStudyItem } from '../app/account-study-content.ts';
import { quizBody } from './fixtures/account-study-fixtures.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/course-task-support-v2.json', import.meta.url)));
test('legacy model endpoint never grades V2 using an incomplete task context', async () => {
  for (const reviewStatus of ['verified', 'candidate', 'disputed']) {
    const support = structuredClone(fixture.cases[0].support);
    support.task.reviewStatus = reviewStatus;
    const body = quizBody({ schemaVersion: 2, learningSupport: support });
    body.practice = { ...body.practice, questionType: 'recall', prompt: support.task.prompt };
    delete body.practice.options;
    delete body.practice.answer;
    delete body.practice.explanation;
    const item = await sealStudyItem(body);
    let calls = 0;
    const ai = createAccountStudyQuestionAi({ enabled: true, key: 'synthetic-key', model: 'synthetic-model', fetcher: async () => {
      calls++;
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ text: 'Correct', verdict: 'correct', rating: 'good', matchedPointIds: ['key'], missedPointIds: [] }) } }] }));
    } });
    await assert.rejects(ai.run({ kind: 'recall-grade', snapshotId: 'snapshot-a', itemKey: item.itemKey, contentHash: item.contentHash, attemptId: 'attempt-one', input: 'my answer' }, item, { maxOutputTokens: 300 }), /course-task-evaluation-unavailable/);
    assert.equal(calls, 0);
  }
});
