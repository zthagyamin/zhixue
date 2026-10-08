import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { parseLearningSupport, courseTaskReadiness } from '../src/domain/content/index.ts';
import { sealStudyItem } from '../app/account-study-content.ts';
import { quizBody } from './fixtures/account-study-fixtures.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/course-task-support-v2.json', import.meta.url)));
const python = process.env.PYTHON || 'python';
test('shared V2 JSON including integral numeric spellings has identical acceptance in TS and Python', () => {
  const cases = fixture.cases.map(row => ({ id: row.id, mode: row.mode, inputJson: JSON.stringify(row.support), valid: row.valid }));
  for (const literal of ['2.0', '2e0']) cases.push({ id: `version-${literal}`, mode: 'recall', inputJson: JSON.stringify(fixture.cases[0].support).replace('"schemaVersion":2', `"schemaVersion":${literal}`), valid: true });
  for (const literal of ['1.0', '1e0']) {
    const support = structuredClone(fixture.cases[0].support);
    support.criteria[0].weight = 1;
    cases.push({ id: `weight-${literal}`, mode: 'recall', inputJson: JSON.stringify(support).replace('"weight":1', `"weight":${literal}`), valid: true });
  }
  for (const locator of ['file:///C:/Users/private.pdf', 'FILE://server/share.pdf', ' /private/course.pdf']) {
    const support = structuredClone(fixture.cases[0].support);
    support.task.sources[0].locator = locator;
    cases.push({ id: `local-${locator}`, mode: 'recall', inputJson: JSON.stringify(support), valid: false });
  }
  const accepted = cases.map(row => {
    try { parseLearningSupport(JSON.parse(row.inputJson), row.mode); return true; } catch { return false; }
  });
  assert.deepEqual(accepted, cases.map(row => row.valid));
  const script = "import sys,json;sys.path.insert(0,'companion');from learning_support import parse_learning_support\nfor row in json.load(sys.stdin):\n try: parse_learning_support(json.loads(row['inputJson']),row['mode']);ok=True\n except ValueError: ok=False\n print(json.dumps({'id':row['id'],'ok':ok}))";
  const reply = spawnSync(python, ['-X', 'utf8', '-c', script], { input: JSON.stringify(cases), encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(reply.status, 0, reply.stderr);
  assert.deepEqual(reply.stdout.trim().split('\n').map(line => JSON.parse(line)), cases.map((row, index) => ({ id: row.id, ok: accepted[index] })));
});
test('clean course V2 items hash identically across runtimes without duplicated legacy references', async () => {
  const bodies = fixture.cases.filter(row => row.valid).map(row => {
    const body = quizBody({ schemaVersion: 2, learningSupport: row.support });
    body.practice = { itemId: 'question-one', abilityId: 'reading-main', domain: 'course', questionType: row.mode, prompt: row.support.task.prompt, sourceLabel: 'Synthetic course' };
    return body;
  });
  const script = "import sys,json;sys.path.insert(0,'companion');from account_sync_schema import seal_item;print(json.dumps([seal_item(v) for v in json.load(sys.stdin)],ensure_ascii=False))";
  const reply = spawnSync(python, ['-X', 'utf8', '-c', script], { input: JSON.stringify(bodies), encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(reply.status, 0, reply.stderr);
  assert.deepEqual(JSON.parse(reply.stdout), await Promise.all(bodies.map(body => sealStudyItem(body))));
});
test('original synthetic material stays QA-only and unreviewed while every source reference parses', () => {
  const material = JSON.parse(readFileSync(new URL('../examples/course-tasks/requirements-original.json', import.meta.url)));
  assert.equal(material.status, 'qa-only-unmapped');
  for (const item of material.items) {
    const support = parseLearningSupport(item.learningSupport, item.learningSupport.type);
    assert.ok(courseTaskReadiness(support.task, item.prompt).includes('course-task-unreviewed'));
    assert.equal(support.task.sources.every(source => source.version === material.sourceVersion), true);
  }
});
