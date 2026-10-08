import assert from "node:assert/strict";
import test from "node:test";

import { buildDueReviewItems } from "../app/due-review-items.ts";

test("flattens every Companion due-review study item", () => {
  const reviews = [
    {
      courseId: "CS231n",
      lectureNo: 16,
      topic: "Vision and Language",
      reviewDate: "2026-08-23",
      timing: "overdue",
      itemCount: 2,
      nextAction: "定向复测",
      path: "学习记录/第16讲 学习状态.md",
      studyItems: [
        { id: "due:clip", pluginType: "flashcard", front: "CLIP loss", back: "核对来源" },
        { id: "due:zero-shot", pluginType: "flashcard", front: "zero-shot", back: "核对来源" },
      ],
    },
  ];

  const items = buildDueReviewItems(reviews);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((item) => item.id), ["due:clip", "due:zero-shot"]);
});

test("preserves legacy declared counts instead of shrinking to four static questions", () => {
  const items = buildDueReviewItems([{
    courseId: "CS231n",
    lectureNo: 6,
    topic: "Training Neural Networks",
    reviewDate: "2026-08-16",
    timing: "overdue",
    itemCount: 6,
    nextAction: "按原笔记逐项复测",
    path: "学习记录/第06讲 学习状态.md",
  }]);

  assert.equal(items.length, 6);
  assert.ok(items.every((item) => item.pluginType === "flashcard"));
  assert.ok(items.every((item) => item.stateRef === "学习记录/第06讲 学习状态.md"));
});
