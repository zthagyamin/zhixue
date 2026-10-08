import test from 'node:test';
import assert from 'node:assert/strict';
import {makeWordCloze} from '../app/word-cloze.ts';
test('cloze replaces complete literal words while preserving the supplied sentence',()=>{
  assert.equal(makeWordCloze('Art is an art, not part.','art'),'______ is an ______, not part.');
  assert.equal(makeWordCloze('We use C++ today.','C++'),'We use ______ today.');
  assert.equal(makeWordCloze('A neural network works.','neural network'),'A ______ works.');
});
test('no source match or no word does not fabricate a sentence',()=>{
  assert.equal(makeWordCloze('The artist arrived.','art'),null);assert.equal(makeWordCloze('','word'),null);assert.equal(makeWordCloze('anything',''),null);
});
