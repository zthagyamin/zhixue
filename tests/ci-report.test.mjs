import test from 'node:test';
import assert from 'node:assert/strict';
import {tapTotals, fullPassed, browserPassed, gatePassed} from '../scripts/ci-report.mjs';
const sha = 'a'.repeat(40);
const goodTotals = {tests: 1672, pass: 1672, fail: 0, cancelled: 0, skipped: 0, todo: 0};
const tap = Object.entries(goodTotals).map(([key,value]) => '# ' + key + ' ' + value).join('\r\n');
const browser = () => ({sha, complete: true, failure: null, expected: 2, passed: 2, results: [{passed:true},{passed:true}]});

test('CI extracts actual TAP totals including Windows line endings', () => {
  assert.deepEqual(tapTotals(tap), goodTotals);
  assert.equal(fullPassed(tapTotals(tap), 'success'), true);
});
test('CI takes the final TAP totals instead of an earlier nested summary', () => {
  assert.deepEqual(tapTotals('# tests 1\n# pass 1\n' + tap), goodTotals);
});
test('CI never turns missing, partial or below-baseline coverage green', () => {
  for (const totals of [tapTotals(''), tapTotals('# fail 0'), {...goodTotals, tests:0, pass:0}, {...goodTotals, tests:1671, pass:1671}]) {
    assert.equal(fullPassed(totals, 'success'), false);
  }
});
test('CI rejects skips, cancellations, failures, todo and failed process outcomes', () => {
  for (const field of ['fail','cancelled','skipped','todo']) assert.equal(fullPassed({...goodTotals,[field]:1}, 'success'), false);
  for (const outcome of ['failure','cancelled','skipped',undefined]) assert.equal(fullPassed(goodTotals, outcome), false);
});
test('CI browser evidence must match the exact current commit and all cases', () => {
  assert.equal(browserPassed(browser(),2,sha,'success'), true);
  for (const report of [null,{...browser(),sha:'b'.repeat(40)},{...browser(),complete:false},{...browser(),failure:'error'},{...browser(),passed:1},{...browser(),results:[{passed:true}]},{...browser(),results:[{passed:true},{passed:false}]}]) {
    assert.equal(browserPassed(report,2,sha,'success'), false);
  }
});
test('CI browser success cannot conceal a failed command or invalid expectation', () => {
  assert.equal(browserPassed(browser(),2,sha,'failure'), false);
  assert.equal(browserPassed(browser(),0,sha,'success'), false);
  assert.equal(browserPassed(browser(),2,undefined,'success'), false);
});
test('CI final gate passes only when every required job succeeds', () => {
  assert.equal(gatePassed({full:{result:'success'},browser:{result:'success'}}), true);
  for (const result of ['failure','cancelled','skipped',undefined]) {
    assert.equal(gatePassed({full:{result},browser:{result:'success'}}), false);
    assert.equal(gatePassed({full:{result:'success'},browser:{result}}), false);
  }
});
test('CI final gate rejects absent dependencies and any extra unsuccessful dependency', () => {
  for (const needs of [null,[],{},{full:{result:'success'}},{browser:{result:'success'}},{full:{result:'success'},browser:{result:'success'},extra:{result:'failure'}}]) assert.equal(gatePassed(needs), false);
});
