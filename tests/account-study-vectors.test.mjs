import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {accountStudyVectors} from './fixtures/account-study-vectors.mjs';

test('shared Python golden vectors remain exact TypeScript-sealed protocol outputs',async()=>{
  const expected=JSON.parse(await readFile(new URL('./fixtures/account-study-v1.json',import.meta.url),'utf8'));
  assert.deepEqual(await accountStudyVectors(),expected);
});
