import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { sealStudyItem, routableStudyItem } from '../app/account-study-content.ts';
import { sealStudyRecord, checkStudyRecordBinding } from '../app/account-study-record.ts';
import { withStudyEventCoreHash, SCHEDULER_VERSION } from '../app/study-event-v3.ts';
import { checkContentQuality } from '../src/domain/assessment/index.ts';
import { quizBody, recordBody } from './fixtures/account-study-fixtures.mjs';
import { attempt } from './fixtures/task-event-fixtures.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/course-task-support-v2.json', import.meta.url)));
const python = process.env.PYTHON || 'python';
async function record(item) {
  const raw = await attempt('event-course', '2026-10-06T00:02:00Z', 0, 3, true, { scheduling: { reviewedAt: '2026-10-06T00:02:00.000Z', schedulerVersion: SCHEDULER_VERSION } });
  const event = await withStudyEventCoreHash({ ...raw, item: { ...raw.item, kind: item.eventKind, key: item.itemKey } });
  return sealStudyRecord(await recordBody({ contentHash: item.contentHash, practiceMode: item.practice.questionType, event }));
}
test('unready V2 sources cannot receive formal grades through either shared record validator', async () => {
  const cases = [];
  for (const mutation of ['verified', 'candidate', 'disputed', 'prompt', 'conditions']) {
    const learningSupport = structuredClone(fixture.cases.find(row => row.id === 'quiz').support);
    if (['verified', 'candidate', 'disputed'].includes(mutation)) learningSupport.task.reviewStatus = mutation;
    if (mutation === 'conditions') { learningSupport.task.kind = 'conditions'; learningSupport.task.conditions = []; }
    const body = quizBody({ schemaVersion: 2, learningSupport });
    body.practice.prompt = mutation === 'prompt' ? 'A different question' : learningSupport.task.prompt;
    delete body.practice.options;
    delete body.practice.answer;
    const item = await sealStudyItem(body), sealed = await record(item);
    cases.push({ item, record: sealed, valid: mutation === 'verified' });
    if (mutation === 'verified') assert.equal(checkStudyRecordBinding(sealed, item), 'ready');
    else assert.throws(() => checkStudyRecordBinding(sealed, item), /course-task/);
  }
  const script = "import sys,json;sys.path.insert(0,'companion');from account_sync_schema import check_record_binding\nfor row in json.load(sys.stdin):\n try: result=check_record_binding(row['record'],row['item']);valid=result=='ready'\n except ValueError: valid=False\n print(json.dumps({'valid':valid}))";
  const reply = spawnSync(python, ['-X', 'utf8', '-c', script], { input: JSON.stringify(cases), encoding: 'utf8', windowsHide: true, timeout: 10000 });
  assert.equal(reply.status, 0, reply.stderr);
  assert.deepEqual(reply.stdout.trim().split('\n').map(line => JSON.parse(line).valid), cases.map(row => row.valid));
});
test('actual routing adapter empty placeholders cannot hide clean V2 reference criteria', async () => {
  const learningSupport = fixture.cases[0].support;
  const body = quizBody({ schemaVersion: 2, learningSupport });
  body.practice = { itemId: 'question-one', abilityId: 'reading-main', domain: 'course', questionType: 'recall', prompt: learningSupport.task.prompt, sourceLabel: 'Course' };
  const item = await sealStudyItem(body), routed = routableStudyItem(item);
  assert.equal(checkContentQuality('recall', routed).capabilities.canAutoAssess, true);
  assert.equal(checkContentQuality('recall', { ...body.practice, answer: undefined, explanation: '', reviewPoint: undefined, learningSupport }).capabilities.canAutoAssess, true);
});
