import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolveCourseTask, courseTaskHash, validateCourseDiagnostic, deterministicCourseDiagnostic,
  chooseCourseRemediation, courseDiagnosticOutcome, attemptEvaluationForDiagnostic, courseDiagnosticHash,
  parseCourseEvidence, parseCourseEvidenceMutation, applyCourseEvidenceMutation} from '../src/domain/course-study/index.ts';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/course-study-diagnostics-v1.json', import.meta.url)));
fixture.cases = fixture.cases.map(row => ({...row, support: fixture.supports[row.supportId],
  diagnostic: {...fixture.diagnosticBase,...row.diagnosticOverrides}}));
fixture.mutationCases = fixture.mutationCases.map(row => ({...row,
  mutation: {...fixture.mutationTemplates[row.template],...row.overrides,binding:fixture.binding}}));
function item(support) {
  return {schemaVersion:2,kind:'practice',eventKind:'due',contentHash:'a'.repeat(64), learningSupport:support,
    practice:{questionType:support.type,prompt:support.task.prompt,domain:'course'}};
}
for (const row of fixture.cases) {
  test(`source-bound diagnostic: ${row.id}`, () => {
    const task = resolveCourseTask(item(row.support));
    const before = structuredClone(row);
    if (row.valid) assert.deepEqual(validateCourseDiagnostic(row.diagnostic, task, row.answer), row.diagnostic);
    else assert.throws(() => validateCourseDiagnostic(row.diagnostic, task, row.answer));
    assert.deepEqual(row, before);
  });
}
for (const row of fixture.mutationCases) {
  test(`closed evidence mutation fixture: ${row.id}`, () => {
    if (row.valid) assert.deepEqual(parseCourseEvidenceMutation(row.mutation),row.mutation);
    else assert.throws(() => parseCourseEvidenceMutation(row.mutation));
  });
}
test('full task identity includes sources, references and child conditions', async () => {
  const support = structuredClone(fixture.cases[0].support), task = resolveCourseTask(item(support));
  const child = resolveCourseTask(item(support), support.task.remediations[0].taskId);
  assert.equal(child.answer, support.task.remediations[0].answer);
  assert.deepEqual(child.sources, support.task.sources);
  assert.notEqual(await courseTaskHash(task), await courseTaskHash(child));
  support.task.sources[0].version = 'b'.repeat(64);
  assert.notEqual(await courseTaskHash(task), await courseTaskHash(resolveCourseTask(item(support))));
  support.task.remediations[0].kind = 'application';
  support.task.remediations[0].conditions = [];
  assert.throws(() => resolveCourseTask(item(support), support.task.remediations[0].taskId));
});
test('rejects legacy, unreviewed, mismatched, generic and duplicate-reference sources', () => {
  const source = item(fixture.cases[0].support);
  for (const change of [v => v.schemaVersion = 1, v => v.kind = 'word',
    v => v.learningSupport.task.reviewStatus = 'candidate', v => v.practice.prompt = 'Other prompt',
    v => v.practice.answer = 'legacy', v => v.learningSupport.task.prompt = v.practice.prompt = '请闭卷回忆「栈」的核心要点，并说明相关概念、依据或适用条件。']) {
    const next = structuredClone(source); change(next); assert.throws(() => resolveCourseTask(next));
  }
  assert.throws(() => resolveCourseTask(source, 'invented-task'));
});
test('quiz uses original stable IDs without claiming semantic point alignment', () => {
  const task = resolveCourseTask(item(fixture.quizSupport));
  for (const row of fixture.quizCases) {
    if (!row.valid) { assert.throws(() => deterministicCourseDiagnostic(task, row.answer)); continue; }
    const diagnostic = deterministicCourseDiagnostic(task, row.answer);
    assert.equal(diagnostic.status, row.status);
    assert.deepEqual(diagnostic.wrongOptionIds, row.wrongOptionIds);
    assert.deepEqual(diagnostic.missingOptionIds, row.missingOptionIds);
    assert.deepEqual(diagnostic.matchedPointIds, []);
    assert.deepEqual(validateCourseDiagnostic(diagnostic, task, row.answer), diagnostic);
    const tampered = {...diagnostic, wrongOptionIds:['a']};
    assert.throws(() => validateCourseDiagnostic(tampered, task, row.answer));
  }
});
test('explicit self-assessment and unknown never invent alignments or remediation', () => {
  const row = fixture.cases[0], task = resolveCourseTask(item(row.support));
  const empty = {schemaVersion:1,status:'incorrect',source:'self-assess',feedback:'Explicit learner choice.',
    matchedPointIds:[],missedPointIds:[],errorPointIds:[],wrongOptionIds:[],missingOptionIds:[],pointEvidence:[]};
  assert.deepEqual(validateCourseDiagnostic(empty,task,row.answer), empty);
  assert.equal(chooseCourseRemediation(row.support,empty),null);
  const unknown = {...empty,status:'undetermined',source:'none',reason:'offline'};
  assert.deepEqual(validateCourseDiagnostic(unknown,task,row.answer), unknown);
  assert.equal(courseDiagnosticOutcome(unknown).rating,undefined);
  assert.equal(attemptEvaluationForDiagnostic(unknown,'a'.repeat(64)).status,'pending');
  for (const status of ['correct','partial','incorrect']) {
    const result = attemptEvaluationForDiagnostic({...empty,status},'a'.repeat(64));
    assert.equal(result.rating,{correct:'good',partial:'hard',incorrect:'again'}[status]);
    assert.equal(result.evaluationHash,'');
  }
});
test('remediation selects one authored mandatory gap first and otherwise retries original', () => {
  const row = fixture.cases.find(value => value.id === 'partial'), support = structuredClone(row.support);
  assert.equal(chooseCourseRemediation(support,row.diagnostic).taskId,support.task.remediations[0].taskId);
  support.task.remediations = [];
  assert.equal(chooseCourseRemediation(support,row.diagnostic),null);
});
const binding = {ownerId:'owner',libraryId:'library',snapshotId:'snapshot',itemKey:'item',contentHash:'a'.repeat(64),groupId:'group',roundId:'round'};
const bind = {schemaVersion:1,kind:'bind',attemptId:'attempt',binding,operationId:'bind',expectedRevision:0,
  updatedAt:'2026-10-06T00:00:00.000Z',taskId:'task-definition',taskHash:'b'.repeat(64),parentAttemptId:null,parentEvidenceHash:null};
test('evidence has immutable binding, CAS, exact replay and never claims durability', async () => {
  const first = applyCourseEvidenceMutation(null,parseCourseEvidenceMutation(bind),'c'.repeat(64));
  assert.equal(first.status,'accepted'); assert.equal(first.revision,1); assert.equal(first.durable,false);
  assert.deepEqual(parseCourseEvidence(first.evidence),first.evidence);
  assert.equal(applyCourseEvidenceMutation(first.evidence,bind,'c'.repeat(64)).status,'duplicate');
  assert.equal(applyCourseEvidenceMutation(first.evidence,bind,'d'.repeat(64)).status,'conflict');
  for (const override of [{taskHash:'d'.repeat(64)},{taskId:'other'},{parentAttemptId:'parent',parentEvidenceHash:'d'.repeat(64)},
    {binding:{...binding,ownerId:'other'}},{expectedRevision:0}]) {
    assert.equal(applyCourseEvidenceMutation(first.evidence,{...bind,operationId:'other',expectedRevision:1,...override},'d'.repeat(64)).status,'conflict');
  }
  const row = fixture.cases[0], trace = fixture.trace;
  const diagnosticHash = await courseDiagnosticHash(row.diagnostic,trace);
  assert.notEqual(diagnosticHash,await courseDiagnosticHash(row.diagnostic,{...trace,requestId:'other'}));
  const diagnose = {schemaVersion:1,kind:'diagnose',attemptId:'attempt',binding,operationId:'diagnose',expectedRevision:1,
    updatedAt:bind.updatedAt,answerRevision:2,diagnostic:row.diagnostic,trace,diagnosticHash,attemptEvaluationHash:'e'.repeat(64)};
  const resolved = applyCourseEvidenceMutation(first.evidence,parseCourseEvidenceMutation(diagnose),'f'.repeat(64));
  assert.equal(resolved.status,'accepted'); assert.equal(resolved.evidence.answerRevision,2);
  assert.equal(applyCourseEvidenceMutation(resolved.evidence,{...diagnose,operationId:'late',expectedRevision:2,answerRevision:3},'a'.repeat(64)).status,'conflict');
  const identical = applyCourseEvidenceMutation(resolved.evidence,{...diagnose,operationId:'late',expectedRevision:2},'a'.repeat(64));
  assert.equal(identical.status,'accepted');
  assert.equal(identical.revision,3);
  assert.deepEqual(identical.evidence.operations.at(-1),{operationId:'late',fingerprint:'a'.repeat(64)});
  assert.equal(applyCourseEvidenceMutation(resolved.evidence,{...diagnose,operationId:'late',expectedRevision:2,diagnosticHash:'a'.repeat(64)},'a'.repeat(64)).status,'conflict');
});
test('unknown diagnostic locks original answer revision and may resolve later', async () => {
  const first = applyCourseEvidenceMutation(null,bind,'c'.repeat(64)).evidence;
  const diagnostic = fixture.cases.find(row => row.id === 'unknown').diagnostic;
  const pending = {schemaVersion:1,kind:'diagnose',attemptId:'attempt',binding,operationId:'pending',expectedRevision:1,updatedAt:bind.updatedAt,
    answerRevision:2,diagnostic,trace:null,diagnosticHash:await courseDiagnosticHash(diagnostic,null),attemptEvaluationHash:null};
  const state = applyCourseEvidenceMutation(first,pending,'d'.repeat(64)).evidence;
  const row = fixture.cases[0];
  const next = {...pending,operationId:'resolve',expectedRevision:2,diagnostic:row.diagnostic,trace:fixture.trace,
    diagnosticHash:await courseDiagnosticHash(row.diagnostic,fixture.trace),attemptEvaluationHash:'e'.repeat(64)};
  assert.equal(applyCourseEvidenceMutation(state,{...next,answerRevision:3},'f'.repeat(64)).status,'conflict');
  assert.equal(applyCourseEvidenceMutation(state,next,'f'.repeat(64)).status,'accepted');
});
test('closed evidence protocol rejects malformed dates, IDs, trace and hashes', () => {
  for (const overrides of [{unexpected:true},{updatedAt:'2026-02-30T00:00:00.000Z'},{operationId:'x'.repeat(121)},
    {operationId:'op\n'}, {attemptId:'attempt\n'}, {taskId:'task\n'},
    {taskId:'x'.repeat(65)},{taskHash:'A'.repeat(64)},{parentAttemptId:'attempt',parentEvidenceHash:'a'.repeat(64)}]) {
    assert.throws(() => parseCourseEvidenceMutation({...bind,...overrides}));
  }
  const row = fixture.cases[0];
  const raw = {...bind,kind:'diagnose',answerRevision:1,diagnostic:row.diagnostic,trace:null,diagnosticHash:'a'.repeat(64),attemptEvaluationHash:'b'.repeat(64)};
  delete raw.taskId; delete raw.taskHash; delete raw.parentAttemptId; delete raw.parentEvidenceHash;
  assert.throws(() => parseCourseEvidenceMutation(raw));
  assert.throws(() => parseCourseEvidenceMutation({...raw,trace:{...fixture.trace,requestId:'request\n'}}));
});
