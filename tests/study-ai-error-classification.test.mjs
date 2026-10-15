import test from 'node:test';
import assert from 'node:assert/strict';
import {studyAIErrorCode, studyAIErrorMessage} from '../src/domain/ai/index.ts';

test('incomplete and limited responses retain their actionable error category', () => {
  for (const code of ['ai-stream-incomplete', 'ai-stream-limit']) {
    assert.equal(studyAIErrorCode(new Error(code)), code);
    assert.match(studyAIErrorMessage(code), /回答|传输/);
    assert.doesNotMatch(studyAIErrorMessage(code), /已完成|掌握|自动重试/);
  }
});

test('private unknown error detail is replaced and timeout remains separate', () => {
  assert.equal(studyAIErrorCode(new Error('synthetic-private-detail')), 'ai-provider-error');
  assert.doesNotMatch(studyAIErrorMessage('synthetic-private-detail'), /synthetic/);
  const timeout = new Error('synthetic-private-detail');
  timeout.name = 'TimeoutError';
  assert.equal(studyAIErrorCode(timeout), 'ai-provider-timeout');
});
