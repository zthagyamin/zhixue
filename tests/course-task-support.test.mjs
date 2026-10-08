import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseLearningSupport } from '../src/domain/content/index.ts';
import { checkContentQuality } from '../src/domain/assessment/index.ts';
import { sealStudyItem, parseStudyItem } from '../app/account-study-content.ts';
import { quizBody, wordBody } from './fixtures/account-study-fixtures.mjs';
import { quizMaterial } from '../src/domain/content/index.ts';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/course-task-support-v2.json', import.meta.url)));
for (const row of fixture.cases) {
  test(`course V2 closed source contract: ${row.id}`, () => {
    const before = structuredClone(row.support);
    if (row.valid) {
      assert.deepEqual(parseLearningSupport(row.support, row.mode), row.support);
    } else assert.throws(() => parseLearningSupport(row.support, row.mode));
    assert.deepEqual(row.support, before, 'source objects are never mutated');
  });
}
for (const row of fixture.cases.filter(row => row.valid)) {
  test(`course V2 content binding and readiness: ${row.id}`, () => {
    const data = { prompt: row.support.task.prompt, learningSupport: row.support };
    assert.equal(checkContentQuality(row.mode, data).capabilities.canAutoAssess, true);
    for (const status of ['candidate', 'disputed']) {
      const pending = structuredClone(data);
      pending.learningSupport.task.reviewStatus = status;
      const quality = checkContentQuality(row.mode, pending);
      assert.equal(quality.capabilities.canDisplay, true);
      assert.equal(quality.capabilities.canAutoAssess, false);
      assert.equal(quality.capabilities.canSelfCheck, false);
      assert.ok(quality.issues.some(issue => issue.code === 'course-task-unreviewed'));
    }
    const mismatch = checkContentQuality(row.mode, { ...data, prompt: '另一个任务' });
    assert.equal(mismatch.capabilities.canAutoAssess, false);
    assert.ok(mismatch.issues.some(issue => issue.code === 'course-task-prompt-mismatch'));
  });
}
test('conditions and application tasks require stated conditions; known generic prompts stay blocked', () => {
  for (const row of fixture.cases.filter(row => row.valid && ['conditions', 'application'].includes(row.support.task.kind))) {
    const support = structuredClone(row.support);
    support.task.conditions = [];
    const quality = checkContentQuality(row.mode, { prompt: support.task.prompt, learningSupport: support });
    assert.equal(quality.capabilities.canAutoAssess, false);
    assert.ok(quality.issues.some(issue => issue.code === 'course-task-missing-conditions'));
  }
  const support = structuredClone(fixture.cases[0].support);
  support.task.prompt = '请闭卷回忆「栈」的核心要点，并说明相关概念、依据或适用条件。';
  assert.equal(checkContentQuality('recall', { prompt: support.task.prompt, learningSupport: support }).capabilities.canAutoAssess, false);
});
test('course V2 survives existing published item hashing; older items retain identity', async () => {
  const legacy = quizBody();
  const old = await sealStudyItem(legacy);
  for (const row of fixture.cases.filter(row => row.valid)) {
    const body = { ...legacy, schemaVersion: 2, learningSupport: row.support, practice: { ...legacy.practice, questionType: row.mode, prompt: row.support.task.prompt } };
    delete body.practice.options;
    delete body.practice.answer;
    delete body.practice.explanation;
    const sealed = await sealStudyItem(body);
    assert.deepEqual((await parseStudyItem(sealed)).learningSupport, row.support);
    assert.notEqual(sealed.contentHash, old.contentHash);
  }
  assert.deepEqual(await sealStudyItem(legacy), old);
});
test('new recall criteria are the sole reference; an old reference cannot shadow them', async () => {
  const learningSupport = fixture.cases[0].support;
  const body = quizBody({ schemaVersion: 2, learningSupport });
  body.practice = { itemId: 'question-one', abilityId: 'reading-main', domain: 'course', questionType: 'recall', prompt: learningSupport.task.prompt, sourceLabel: 'Course' };
  const sealed = await sealStudyItem(body);
  assert.deepEqual((await parseStudyItem(sealed)).learningSupport, learningSupport);
  for (const key of ['answer', 'explanation', 'reviewPoint']) {
    const contradictory = { ...body, practice: { ...body.practice, [key]: 'An unrelated legacy answer' } };
    await assert.rejects(sealStudyItem(contradictory), /duplicate-course-reference/);
    const quality = checkContentQuality('recall', { ...contradictory.practice, learningSupport });
    assert.equal(quality.capabilities.canAutoAssess, false);
    assert.ok(quality.issues.some(issue => issue.code === 'duplicate-course-reference'));
  }
});
test('review state is a string, never a coercible container', () => {
  const support = structuredClone(fixture.cases[0].support);
  support.task.reviewStatus = ['verified'];
  assert.throws(() => parseLearningSupport(support, 'recall'));
});
test('course content never attaches to word material even after a display override', async () => {
  const learningSupport = fixture.cases[0].support;
  await assert.rejects(sealStudyItem(wordBody({ schemaVersion: 2, completionRule: 'graded-practice', recommendedPlugin: 'recall', learningSupport })), /course-task-word/);
  const quality = checkContentQuality('recall', { word: 'stack', meaning: '栈', prompt: learningSupport.task.prompt, learningSupport });
  assert.equal(quality.capabilities.canAutoAssess, false);
  assert.ok(quality.issues.some(issue => issue.code === 'course-task-word'));
});
test('new quiz adapter exposes supplied explanations for wrong and missed options', () => {
  const support = fixture.cases.find(row => row.id === 'quiz').support;
  const material = quizMaterial({ learningSupport: support });
  assert.deepEqual(material.options.map(option => option.explanation), support.options.map(option => option.explanation));
});
test('sparse in-memory source lists cannot masquerade as complete JSON content', () => {
  for (const field of ['criteria', 'sources', 'remediations']) {
    const support = structuredClone(fixture.cases[0].support);
    if (field === 'criteria') support.criteria = Array(1);
    else support.task[field] = Array(1);
    assert.throws(() => parseLearningSupport(support, 'recall'));
  }
});
