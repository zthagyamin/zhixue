import assert from "node:assert/strict";
import test from "node:test";
import { advanceThreeStageSession } from "../app/three-stage-order.ts";

test("a correct answer advances only that word and switches to another incomplete word", () => {
  const result = advanceThreeStageSession({
    currentIndex: 0,
    stages: [0, 0, 0],
    correct: true,
    random: () => 0,
  });

  assert.deepEqual(result, { stages: [1, 0, 0], nextIndex: 1, complete: false });
});

test("different words can be interleaved while each word keeps its own next stage", () => {
  const original = [1, 0, 2, 3];
  const result = advanceThreeStageSession({
    currentIndex: 2,
    stages: original,
    correct: true,
    random: () => 0.999,
  });

  assert.deepEqual(result, { stages: [1, 0, 3, 3], nextIndex: 1, complete: false });
  assert.deepEqual(original, [1, 0, 2, 3]);
});

test("a wrong answer resets only the current word before returning it to the random queue", () => {
  const result = advanceThreeStageSession({
    currentIndex: 0,
    stages: [2, 1, 0],
    correct: false,
    random: () => 0,
  });

  assert.deepEqual(result, { stages: [0, 1, 0], nextIndex: 1, complete: false });
});

test("the only unfinished word remains selected", () => {
  const result = advanceThreeStageSession({
    currentIndex: 1,
    stages: [3, 1, 3],
    correct: true,
    random: () => 0.5,
  });

  assert.deepEqual(result, { stages: [3, 2, 3], nextIndex: 1, complete: false });
});

test("finishing the last word signals a complete round instead of staying on the same word", () => {
  const result = advanceThreeStageSession({
    currentIndex: 2,
    stages: [3, 3, 2],
    correct: true,
    random: () => 0,
  });

  assert.deepEqual(result, { stages: [3, 3, 3], nextIndex: 2, complete: true });
});
