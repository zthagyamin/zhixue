export type ReviewDiagnostics = {
  localEventCount?: number;
  localPending: number;
  cloudBehind: boolean;
  /** Current local conflict records (drives severity). */
  conflicts: number;
  projectionMismatchCount: number;
  source?: "rebuilt" | "legacy-baseline";
  cloudCursor?: number;
  schedulerVersion?: string;
  companionEventSetHash?: string;
  localEventSetHash?: string;
  /** Cumulative Companion counters, informational only. */
  companionConflictCount?: number;
  companionDuplicateCount?: number;
};

export type ReplicaStateSummary = {
  level: "healthy" | "pending" | "behind" | "mismatch" | "conflict";
  label: string;
  sourceLabel?: string;
};

/**
 * Ranks replica health: conflict is the highest severity, then client/server
 * projection mismatch, then a behind replica, then pending delivery, then
 * healthy. The baseline/rebuilt source is reported separately as a label.
 */
export function summarizeReplicaState(input: ReviewDiagnostics): ReplicaStateSummary {
  if (input.conflicts > 0) {
    return { level: "conflict", label: "存在事件冲突，需检查后手动处理" };
  }
  if (input.projectionMismatchCount > 0) {
    return { level: "mismatch", label: "存在复习状态投影不一致，已保留服务端结果" };
  }
  if (input.cloudBehind) {
    return { level: "behind", label: "本机复习状态落后于云端，尚有事件未下载" };
  }
  if (input.localPending > 0) {
    return { level: "pending", label: "本机有待送达的复习事件" };
  }
  return {
    level: "healthy",
    label: "各端复习状态一致",
    ...(input.source === undefined ? {} : { sourceLabel: input.source === "legacy-baseline" ? "旧数据基线" : "事件重建" }),
  };
}
