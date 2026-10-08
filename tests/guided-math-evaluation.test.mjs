import assert from 'node:assert/strict';
import test from 'node:test';
import {evaluateDevelopmentFixtures} from '../scripts/evaluate-guided-math.mjs';
test('the declared engineering dataset reports denominators, abstentions and its actual evidence limits',async()=>{
    const report=await evaluateDevelopmentFixtures();
    assert.equal(report.total,20);assert.equal(report.matchingExpected,20);
    assert.equal(report.criticalCases,6);assert.equal(report.criticalFalseAccepts,0);
    assert.equal(report.determined,18);assert.equal(report.unknown,2);
    assert.equal(report.humanReviewedCases,0);assert.equal(report.unseenHoldoutCases,0);
    assert.equal(report.modelEvaluations,0);assert.equal(report.delayedLearnerMeasurements,0);
});
