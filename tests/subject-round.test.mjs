import assert from "node:assert/strict";
import test from "node:test";
import { advanceSubjectRound, clearItemStages, emptySubjectRound, focusRound, isSubjectRoundComplete } from "../app/subject-round.ts";

// Default correctness traversal remains available for vocabulary and legacy callers.
// Non-word hosts opt into completeAfterAttempt only after their durable save/continue boundary;
// tests/nonword-traversal.test.mjs covers that policy without changing correctness.

test("a correct answer moves the item out of the round queue and advances to the next unanswered item", () => {
  const result = advanceSubjectRound({
    round: emptySubjectRound(),
    itemKeys: ["a", "b", "c"],
    currentIndex: 0,
    correct: true,
  });

  assert.deepEqual(result.round.correctKeys, ["a"]);
  assert.equal(result.complete, false);
  assert.equal(result.nextIndex, 1);
});

test("a wrong answer counts a reset and stays in the round queue", () => {
  const result = advanceSubjectRound({
    round: emptySubjectRound(),
    itemKeys: ["a", "b"],
    currentIndex: 1,
    correct: false,
  });

  assert.deepEqual(result.round.correctKeys, []);
  assert.equal(result.round.resets, 1);
  assert.equal(result.complete, false);
  assert.equal(result.nextIndex, 0);
});

test("a wrong answer after a correct one requeues the item until it is answered correctly again", () => {
  const first = advanceSubjectRound({
    round: emptySubjectRound(),
    itemKeys: ["a", "b"],
    currentIndex: 0,
    correct: true,
  });
  const second = advanceSubjectRound({
    round: first.round,
    itemKeys: ["a", "b"],
    currentIndex: 1,
    correct: false,
  });
  const third = advanceSubjectRound({
    round: second.round,
    itemKeys: ["a", "b"],
    currentIndex: 0,
    correct: true,
  });

  assert.equal(first.complete, false);
  assert.equal(second.complete, false);
  assert.equal(third.complete, false);
  assert.equal(third.nextIndex, 1);
  assert.deepEqual(third.round.correctKeys, ["a"]);
});

test("answering the last outstanding item correctly completes the round", () => {
  const first = advanceSubjectRound({
    round: emptySubjectRound(),
    itemKeys: ["a", "b", "c"],
    currentIndex: 0,
    correct: true,
  });
  const second = advanceSubjectRound({
    round: first.round,
    itemKeys: ["a", "b", "c"],
    currentIndex: 1,
    correct: true,
  });
  const third = advanceSubjectRound({
    round: second.round,
    itemKeys: ["a", "b", "c"],
    currentIndex: 2,
    correct: true,
  });

  assert.deepEqual(third.round.correctKeys, ["a", "b", "c"]);
  assert.equal(third.complete, true);
});

test("completion works regardless of visit order because the queue skips already-correct items", () => {
  const steps = [
    { currentIndex: 1, correct: true },
    { currentIndex: 2, correct: false },
    { currentIndex: 0, correct: true },
    { currentIndex: 2, correct: true },
  ];
  let round = emptySubjectRound();
  let last;
  for (const step of steps) {
    last = advanceSubjectRound({
      round,
      itemKeys: ["a", "b", "c"],
      currentIndex: step.currentIndex,
      correct: step.correct,
    });
    round = last.round;
  }

  assert.equal(last.complete, true);
  assert.equal(last.round.resets, 1);
});

test("a single-item subject completes on its first correct answer", () => {
  const result = advanceSubjectRound({
    round: emptySubjectRound(),
    itemKeys: ["only"],
    currentIndex: 0,
    correct: true,
  });

  assert.equal(result.complete, true);
});

test("clearing round stages removes only the subject's keys and leaves other progress untouched", () => {
  const itemStages = { "ielts:alpha": 3, "ielts:beta": 2, "python:quiz-1": 3 };
  const result = clearItemStages(itemStages, ["ielts:alpha", "ielts:beta", ""]);

  assert.deepEqual(result, { "python:quiz-1": 3 });
  assert.deepEqual(itemStages, { "ielts:alpha": 3, "ielts:beta": 2, "python:quiz-1": 3 });
});

test("a wrong answer is recorded in wrongKeys and stays after a later correct answer", () => {
  const first = advanceSubjectRound({
    round: emptySubjectRound(),
    itemKeys: ["a", "b"],
    currentIndex: 0,
    correct: false,
  });
  assert.deepEqual(first.round.wrongKeys, ["a"]);

  const second = advanceSubjectRound({
    round: first.round,
    itemKeys: ["a", "b"],
    currentIndex: 0,
    correct: true,
  });
  assert.deepEqual(second.round.wrongKeys, ["a"]);
  assert.deepEqual(second.round.correctKeys, ["a"]);
});

test("wrongKeys accumulates without duplicates across repeated wrong answers", () => {
  let round = emptySubjectRound();
  for (let i = 0; i < 3; i += 1) {
    round = advanceSubjectRound({ round, itemKeys: ["a", "b"], currentIndex: 0, correct: false }).round;
  }

  assert.deepEqual(round.wrongKeys, ["a"]);
  assert.equal(round.resets, 3);
});

test("focusRound seeds a round that only drills the chosen keys", () => {
  const seeded = focusRound(["a", "b", "c"], ["b"]);
  assert.deepEqual(seeded.correctKeys, ["a", "c"]);

  const first = advanceSubjectRound({ round: seeded, itemKeys: ["a", "b", "c"], currentIndex: 1, correct: false });
  assert.equal(first.complete, false);
  const second = advanceSubjectRound({ round: first.round, itemKeys: ["a", "b", "c"], currentIndex: 1, correct: true });
  assert.equal(second.complete, true);
});

test("every subject reports round completion through one shared check", () => {
  const items = [{ id: "w1" }, { id: "w2" }];
  const keyOf = (item) => `ielts:${item.id}`;

  // 词汇：读持久化阶段
  assert.equal(isSubjectRoundComplete({
    pluginType: "three-stage",
    items,
    itemStages: { "ielts:w1": 3, "ielts:w2": 3 },
    keyOf,
    round: emptySubjectRound(),
  }), true);
  assert.equal(isSubjectRoundComplete({
    pluginType: "three-stage",
    items,
    itemStages: { "ielts:w1": 3, "ielts:w2": 2 },
    keyOf,
    round: emptySubjectRound(),
  }), false);

  // 其他模块：读本轮答对集合
  assert.equal(isSubjectRoundComplete({
    pluginType: "quiz",
    items,
    itemStages: {},
    keyOf,
    round: { correctKeys: ["ielts:w1", "ielts:w2"], wrongKeys: [], resets: 0 },
  }), true);
  assert.equal(isSubjectRoundComplete({
    pluginType: "quiz",
    items,
    itemStages: {},
    keyOf,
    round: { correctKeys: ["ielts:w1"], wrongKeys: [], resets: 0 },
  }), false);
});
