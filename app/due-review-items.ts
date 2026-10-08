import type { RoutableStudyItem } from "./plugin-routing";

export type DueReviewSource = {
  courseId: string;
  lectureNo?: number;
  topic: string;
  reviewDate: string;
  timing: "today" | "overdue";
  itemCount: number;
  nextAction: string;
  path: string;
  studyItems?: RoutableStudyItem[];
};

function safeCount(value: unknown): number {
  const count = Number(value);
  return Number.isInteger(count) && count > 0 ? Math.min(count, 100) : 1;
}

export function buildDueReviewItems(reviews: readonly DueReviewSource[] | undefined): RoutableStudyItem[] {
  return (reviews || []).flatMap((review) => {
    if (Array.isArray(review.studyItems) && review.studyItems.length > 0) {
      return review.studyItems;
    }

    return Array.from({ length: safeCount(review.itemCount) }, (_, index) => ({
      id: `due:${review.courseId || review.path}:${review.lectureNo || "note"}:${index + 1}`,
      pluginType: "flashcard" as const,
      front: `${review.topic} · 复习点 ${index + 1}`,
      back: `${review.nextAction || "完成主动回忆后核对原笔记"}\n\n来源：${review.path}`,
      sourceNote: review.path,
      stateRef: review.path,
      abilityId: `review-${review.lectureNo || "note"}-${index + 1}`,
    }));
  });
}
