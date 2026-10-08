import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolveCourseTask, validateCourseDiagnostic, chooseCourseRemediation,
  courseDiagnosticOutcome, attemptEvaluationForDiagnostic} from '../src/domain/course-study/index.ts';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/course-study-diagnostics-v1.json', import.meta.url)));
const matrixRows = fixture.cases.filter(row => row.id.startsWith('matrix-'));
assert.equal(matrixRows.length, 20, 'all twenty authored outcomes must be present');
for (const kind of ['definition', 'steps', 'comparison', 'conditions', 'application']) {
  test(`authored ${kind} cases cover all four source-bound outcomes`, () => {
    const rows = matrixRows.filter(row => row.valid && fixture.supports[row.supportId].task.kind === kind);
    assert.equal(rows.length, 4, 'each authored task must retain four distinct outcomes');
    assert.deepEqual([...new Set(rows.map(row => row.supportId))], ['matrix-' + kind]);
    const statuses = rows.map(row => ({...fixture.diagnosticBase, ...row.diagnosticOverrides}).status);
    assert.deepEqual([...new Set(statuses)].sort(), ['correct', 'incorrect', 'partial', 'undetermined']);
    for (const row of rows) {
      const support = fixture.supports[row.supportId];
      const before = structuredClone(support);
      const item = {schemaVersion:2, kind:'practice', eventKind:'due', contentHash:'a'.repeat(64),
        learningSupport:support, practice:{questionType:'recall', prompt:support.task.prompt, domain:'course'}};
      const task = resolveCourseTask(item);
      const diagnostic = {...fixture.diagnosticBase, ...row.diagnosticOverrides};
      assert.deepEqual(validateCourseDiagnostic(diagnostic, task, row.answer), diagnostic);
      const rating = {correct:'good', partial:'hard', incorrect:'again'}[diagnostic.status];
      assert.equal(courseDiagnosticOutcome(diagnostic).rating, rating);
      const evaluation = attemptEvaluationForDiagnostic(diagnostic, 'b'.repeat(64));
      const child = chooseCourseRemediation(support, diagnostic);
      if (diagnostic.status === 'undetermined') {
        assert.equal(evaluation.status, 'pending');
        assert.equal(child, null);
        assert.deepEqual(diagnostic.pointEvidence, []);
      } else if (diagnostic.status === 'correct') assert.equal(child, null);
      else {
        assert.equal(child.kind, kind);
        assert.deepEqual(child.targetPointIds, ['extra']);
        assert.equal(resolveCourseTask(item, child.taskId).answer, support.criteria[1].text);
      }
      assert.deepEqual(support, before, 'checking outcomes cannot rewrite the source');
    }
  });
}
