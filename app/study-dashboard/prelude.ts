// @ts-expect-error TS5097: standalone Node contracts.
import {studyDay} from '../../src/domain/planning/index.ts';
export {hasProgressData,cloudWordKey,normalizeProgress,applyCloudEvents,emptyProgress,emptyCloudSyncMetadata,type Progress} from '../../src/domain/sync';
// R2 拆解：自 app/study-dashboard.tsx 抽出的模块级前置块（纯函数与常量）。
// 由 TypeScript AST 判定边界并搬运，未改动任何函数体与取值。

import type {LearningSupport,PracticeMode as PluginType} from '../../src/domain/content';
import {type ReactNode} from "react";
import {type StoredPlanSettings} from "../plan-input-builder";
import {loadLongTermPlanState} from '../local-long-term-plan';
import {companionEndpointFromSearch} from '../companion-endpoint';
import {type PendingSettingsSummary} from '../study-settings-model';
import {type ConstraintDocument, type ConstraintMode, type PracticeItem} from "../companion-plan-client";
import {type AccountAiSettingsResponse} from '../account-study-client';
import type {StudyEventV3} from "../study-event-v3";
import {type DueReviewSource} from "../due-review-items";



export type SourceView = "overview" | "connections" | "privacy" | "sources" | "appearance" | "sync" | "ai" | "danger";


export type SettingsOverviewState={scope:string;phase:'loading'|'ready'|'failed';pending:PendingSettingsSummary|null;message:string;checkedAt:string|null;accountAi:AccountAiSettingsResponse|null;accountAiFailed:boolean};


export type RecoveryActionResult={status:'succeeded'|'partial'|'blocked'|'failed'|'cancelled'|'stale';message:string};



export type ConnectionKey = "obsidian" | "localnotes" | "knowledge" | "companion" | "deepseek";


export type Connection = { key: ConnectionKey; label: string; status: "connected" | "ready" | "missing" | "offline" | "warning"; detail: string; count?: number };


export type WordCard = { word: string; phonetic: string; meaning: string; context: string; example: string; source: string; level: string; distractors: string[] };


export type DueReviewItem = DueReviewSource;


export type ActiveProject = { projectId: string; stage?: number; title: string; status: string; nextAction: string; path: string; updated: string };


export type ActiveResearch = { paperId?: string; title: string; path: string; pass?: number; updated?: string };


export type StudyItem = {
  learningSupport?:LearningSupport;
  id?: string;
  itemId?: string;
  contentHash?: string;
  localBindingHash?: string;
  accountSnapshotId?: string;
  accountItemKey?: string;
  eventKind?: 'word'|'python'|'due';
  fingerprint?: string;
  pluginType?: PluginType;
  type?: PluginType;
  word?: string;
  phonetic?: string;
  meaning?: string;
  context?: string;
  example?: string;
  source?: string;
  level?: string;
  distractors?: string[];
  topic?: string;
  prompt?: string;
  code?: string;
  options?: string[];
  answer?: string;
  explanation?: string;
  initialCode?: string;
  testCode?: string;
  solutionCode?: string;
  front?: ReactNode;
  back?: ReactNode;
  tags?: string[];
  sourceNote?: string;
  stateRef?: string;
  abilityId?: string;
  allowLegacyAliases?: boolean;
  stateHandle?: string;
  sourceLabel?: string;
};


export type DailyDashboard = {
  date: string;
  priorities: string[];
  dueReviewCount: number;
  dueReviews: DueReviewItem[];
  activeProjects: ActiveProject[];
  activeResearch: ActiveResearch[];
  activityCount: number;
  activityMinutes: number;
};


export type Subject = {
  id: string;
  name: string;
  pluginType: PluginType;
  domain?: string;
  eventDomain?: string;
  sourceMode?: 'gateway';
  identity?: 'scoped' | 'legacy';
  groupQuota?: number;
  items: StudyItem[];
};



export type StudyPayload = {
    localLibraryId?: string | null;
    status: "connected" | "key_missing" | "offline" | "provider_unavailable" | "error";
    contentMode?: "demo" | "personal";
    syncedAt?: string;
    source: { title: string; path?: string; scope: string };
    subjects: Subject[];
    practiceItems?: PracticeItem[];
    gateway?: {mode: 'indexed'; schemaVersion: number; subjectCount: number; itemCount: number; diagnostics: Array<{code:string;message:string;path?:string}>; progressEvents: StudyEventV3[]; workspaceId?:string};
    connections?: Connection[];
    dashboard?: DailyDashboard;
    message?: string;
  };


export async function nativeLongTermSnapshot(workspaceId:string,payload:StudyPayload){
  if(!payload.localLibraryId)return null;
  const state=await loadLongTermPlanState({workspaceId,libraryId:payload.localLibraryId});
  return state.enabled?state.snapshot:null;
}




export const EMPTY_GATEWAY_EVENTS: StudyEventV3[] = [];


export const EMPTY_CAPABILITIES:string[]=[];


export function scopeStudyPayload(payload: StudyPayload, workspaceId: string): StudyPayload {
  return payload.gateway ? {...payload,gateway:{...payload.gateway,workspaceId}} : payload;
}


export type ReviewQuestion = {
  id: string;
  topic: string;
  prompt: string;
  code?: string;
  options?: string[];
  answer?: string;
  explanation: string;
  sourceNote?: string;
  stateRef?: string;
  abilityId?: string;
  sourceLabel?: string;
  type?: "code" | "quiz";
  initialCode?: string;
  testCode?: string;
  solutionCode?: string;
};


export type ActivityDraft = {
  domain: "differential-review" | "python" | "ielts";
  id: string;
  title: string;
  outcome: "completed" | "needs-review";
  durationMin: number;
  correct: number;
  total: number;
  weakPoints?: string[];
  sourceNote?: string;
  stateRef?: string;
  abilityId?: string;
  hintUsed?: boolean;
};


export type PendingActivity = Omit<ActivityDraft, "id"> & { eventId: string; occurredAt: string; activityType: "website-practice" };


export type SessionUser = { userId: string; displayName: string; email: string };


export type CompanionSession = { token: string; accountLabel: string; capabilities?:string[];baseUrl?:string };



export const baseWords: WordCard[] = [
  { word: "considerably", phonetic: "/kənˈsɪdərəbli/", meaning: "相当地；显著地", context: "论文用它强调结果相较此前水平有明显提升。", example: "The network performed considerably better than previous approaches.", source: "AlexNet · Abstract · p.1", level: "Academic", distractors: ["偶然地", "逐渐地", "仅仅地"] },
  { word: "employ", phonetic: "/ɪmˈplɔɪ/", meaning: "采用；使用", context: "作者采用 dropout 来缓解全连接层的过拟合。", example: "The authors employ dropout to reduce overfitting.", source: "AlexNet · Abstract · p.1", level: "IELTS 6", distractors: ["拒绝", "比较", "限制"] },
  { word: "variant", phonetic: "/ˈveəriənt/", meaning: "变体；不同版本", context: "作者还提交了该模型的一个变体参加比赛。", example: "A variant of the model was entered in the competition.", source: "AlexNet · Abstract · p.1", level: "Academic", distractors: ["结论", "缺陷", "样本"] },
  { word: "exhibit", phonetic: "/ɪɡˈzɪbɪt/", meaning: "表现出；呈现", context: "现实场景中的物体会呈现很大的差异。", example: "Objects in realistic settings exhibit substantial variation.", source: "AlexNet · Introduction · p.1", level: "IELTS 6", distractors: ["隐藏", "消除", "估计"] },
  { word: "variability", phonetic: "/ˌveəriəˈbɪləti/", meaning: "可变性；差异性", context: "它描述同一类别物体在现实图像中的多样变化。", example: "The dataset captures the natural variability within each class.", source: "AlexNet · Introduction · p.1", level: "Academic", distractors: ["稳定性", "可见度", "精确度"] },
  { word: "augment", phonetic: "/ɔːɡˈment/", meaning: "扩充；增强", context: "标签保持变换可以扩充较小的训练数据集。", example: "Label-preserving transformations augment the training set.", source: "AlexNet · Introduction · p.1", level: "IELTS 7", distractors: ["压缩", "标注", "替换"] },
  { word: "shortcoming", phonetic: "/ˈʃɔːtkʌmɪŋ/", meaning: "缺点；不足", context: "论文指出小型图像数据集存在明显不足。", example: "Limited diversity is a major shortcoming of small datasets.", source: "AlexNet · Introduction · p.1", level: "IELTS 6", distractors: ["优势", "来源", "尺度"] },
  { word: "immense", phonetic: "/ɪˈmens/", meaning: "巨大的；极大的", context: "目标识别任务具有极高的复杂度。", example: "Recognizing objects in natural images is an immense challenge.", source: "AlexNet · Introduction · p.1", level: "IELTS 6", distractors: ["有限的", "隐含的", "相似的"] },
  { word: "constitute", phonetic: "/ˈkɒnstɪtjuːt/", meaning: "构成；组成", context: "CNN 构成了适合图像识别的一类模型。", example: "Convolutional networks constitute a powerful class of models.", source: "AlexNet · Introduction · p.1", level: "IELTS 7", distractors: ["预测", "排除", "简化"] },
  { word: "compensate", phonetic: "/ˈkɒmpenseɪt/", meaning: "弥补；补偿", context: "模型中的先验知识用来弥补有限数据未覆盖的信息。", example: "Prior knowledge can compensate for information absent from the data.", source: "AlexNet · Introduction · p.1", level: "IELTS 6", distractors: ["重复", "证实", "分离"] },
  { word: "facilitate", phonetic: "/fəˈsɪlɪteɪt/", meaning: "促进；使便利", context: "高效 GPU 实现让大型 CNN 的训练成为可能。", example: "Efficient GPU code facilitates the training of large networks.", source: "AlexNet · Introduction · p.2", level: "IELTS 7", distractors: ["阻碍", "监督", "测量"] },
  { word: "inferior", phonetic: "/ɪnˈfɪəriə/", meaning: "较差的；次等的", context: "移除任一卷积层都会导致较差的性能。", example: "Removing a convolutional layer produced inferior performance.", source: "AlexNet · Introduction · p.2", level: "IELTS 6", distractors: ["相等的", "新颖的", "稳定的"] },
];





export const pythonQuestions: ReviewQuestion[] = [
  {
    id: "py-matrix-add-code",
    type: "code",
    topic: "NumPy 广播与相加 (实战)",
    prompt: "<p>编写一个函数 <code>matrix_broadcast_add(a, b)</code>。</p><p>接收两个 NumPy 数组 <code>a</code> 和 <code>b</code>。请返回它们相加后的结果数组。</p><p>注意：你的函数应该能处理任何满足广播机制的数组，如果无法广播，请让他自然抛出错误。</p>",
    initialCode: "def matrix_broadcast_add(a, b):\n    # 在此编写代码\n    pass",
    testCode: "import numpy as np\nres1 = matrix_broadcast_add(np.ones((3, 1)), np.arange(4))\nassert res1.shape == (3, 4), 'Test 1 Failed: Shape mismatch'\nassert np.array_equal(res1[0], [1, 2, 3, 4]), 'Test 1 Failed: Value mismatch'\n\nres2 = matrix_broadcast_add(np.array([1, 2]), np.array([10, 20]))\nassert np.array_equal(res2, [11, 22]), 'Test 2 Failed'",
    solutionCode: "def matrix_broadcast_add(a, b):\n    return a + b",
    explanation: "利用 NumPy 强大的广播机制，即使形状不同的数组（如 (3, 1) 和 (4,)），只要在对应维度上满足长度相同或者其中之一为 1，就可以直接使用 + 运算符进行相加。"
  },

  { id: "py-broadcast", topic: "NumPy 广播", prompt: "a.shape=(3, 1)，b.shape=(4,)。a + b 的结果形状是什么？", code: "a = np.ones((3, 1))\nb = np.arange(4)\na + b", options: ["(3, 4)", "(4, 3)", "(3, 1)", "报错"], answer: "(3, 4)", explanation: "从末尾维度比较：1 可以扩展为 4，因此三行分别与 b 相加，得到 (3, 4)。" },
  { id: "py-default", topic: "默认参数", prompt: "为什么不建议用 list 作为函数的默认参数？", code: "def add(x, bucket=[]):\n    bucket.append(x)\n    return bucket", options: ["默认对象会在多次调用间复用", "list 不能作为参数", "append 会返回 None", "函数只能调用一次"], answer: "默认对象会在多次调用间复用", explanation: "默认参数在定义函数时创建一次。可变对象会积累之前调用留下的内容，通常应改用 None。" },
  { id: "py-dict", topic: "字典读取", prompt: "当 key 可能不存在，同时希望提供默认值，哪一种写法最直接？", options: ["d.get(key, default)", "d[key]", "key in d.values()", "d.index(key)"], answer: "d.get(key, default)", explanation: ".get 不会因缺少 key 抛出 KeyError，并能返回显式默认值。" },
  { id: "py-sort", topic: "排序", prompt: "哪一项会返回新的已排序列表，并保留原列表顺序？", options: ["sorted(items)", "items.sort()", "items.reverse()", "sort(items)"], answer: "sorted(items)", explanation: "sorted 接受任意可迭代对象并返回新列表；list.sort 会原地修改并返回 None。" },
  { id: "py-enumerate", topic: "enumerate", prompt: "同时需要元素下标和值时，推荐的 Python 写法是？", options: ["for i, value in enumerate(items)", "for i in range(items)", "for value.index in items", "for i, value in items"], answer: "for i, value in enumerate(items)", explanation: "enumerate 直接生成 (下标, 值)，比手动维护计数器清楚且不易错。" },
];



export const fallbackData: StudyPayload = {
    status: "offline",
    contentMode: "demo",
    source: { title: "示例 · ImageNet Classification with Deep Convolutional Neural Networks", scope: "公开示范内容" },
    subjects: [
      {
        id: "ielts-vocabulary",
        name: "IELTS 核心词汇",
        pluginType: "three-stage",
        items: baseWords
      },
      {
        id: "python-basics",
        name: "Python 基础知识",
        pluginType: "quiz",
        items: pythonQuestions
      }
    ],
};



export const companionUrl = companionEndpointFromSearch(typeof window==='undefined'?'':window.location.search);


export const dailySyncMs = 24 * 60 * 60 * 1000;


export const companionReconnectMs = 5_000;




export const pendingActivityKey = "study-loop-pending-activities-v1";





export function planSettingsFromAuthority(document: ConstraintDocument): StoredPlanSettings {
  const effective = document.effective;
  const rhythm = effective.weeklyRhythm && "workdayMinutes" in effective.weeklyRhythm
    ? effective.weeklyRhythm
    : undefined;
  return {
    constraints: {
      dailyMinutes: {
        ...effective.dailyMinutes,
        source: document.mode === "auto" ? "system" : "user",
      },
      ...(rhythm ? { weeklyRhythm: rhythm } : {}),
      minReviewMinutes: effective.minimumReviewMinutes ?? 15,
      loadFactor: effective.loadFactor ?? 0.9,
    },
    deadlines: document.deadlines,
  };
}



export function authorityFromPlanSettings(
  base: ConstraintDocument,
  settings: StoredPlanSettings,
  mode: ConstraintMode,
  temporaryUntil: string,
): ConstraintDocument {
  const override = mode === "auto" ? null : {
    dailyMinutes: {
      min: settings.constraints.dailyMinutes.min,
      max: settings.constraints.dailyMinutes.max,
    },
    ...(settings.constraints.weeklyRhythm ? { weeklyRhythm: settings.constraints.weeklyRhythm } : {}),
    loadFactor: settings.constraints.loadFactor,
    minimumReviewMinutes: settings.constraints.minReviewMinutes,
  };
  return {
    ...base,
    mode,
    override,
    temporaryUntil: mode === "temporary" && temporaryUntil ? `${temporaryUntil}T23:59:59+08:00` : null,
    deadlines: settings.deadlines,
  };
}









export function markdownNotePath(value?: string) {
  const path = value?.trim();
  return path && path.toLocaleLowerCase("en-US").endsWith(".md") ? path : undefined;
}



// C1：练习条目的 stateRef 来自结果卡（wikilink 目标，不带 .md）。v3 校验与
// 状态投影都要求 .md 路径，缺了它练习事件就降级为 unmapped，写回永不触发。
// 补全 .md 后缀让练习事件携带可解析的 stateRef（与 server 端 item.key 路由
// 双保险）。
export function resolvableNotePath(value?: string) {
  const path = value?.trim();
  if (!path) return undefined;
  return path.toLocaleLowerCase("en-US").endsWith(".md") ? path : `${path}.md`;
}









export function shanghaiDateKey() {
  return studyDay(new Date().toISOString());
}



export function createEventId(domain: ActivityDraft["domain"], id: string) {
  const nonce = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${shanghaiDateKey()}:${domain}:${id}:${nonce}`.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 128);
}



export function domainForSubject(subject: Subject): ActivityDraft["domain"] {
  if (subject.sourceMode === 'gateway') return subject.eventDomain === 'python' ? 'python' : subject.eventDomain === 'ielts' ? 'ielts' : 'differential-review';
  if (subject.domain === "python") return "python";
  if (['differential-review','course','paper','project'].includes(subject.domain ?? '')) return "differential-review";
  const identity = `${subject.id} ${subject.name}`;
  if (/python/i.test(identity)) return "python";
  if (/due|review|到期|差分/i.test(identity)) return "differential-review";
  return "ielts";
}



export function itemKindForDomain(domain: ActivityDraft["domain"]): "word" | "python" | "due" {
  return domain === "python" ? "python" : domain === "differential-review" ? "due" : "word";
}



export function itemLabel(item: StudyItem, index: number) {
  if (item.word) return item.word;
  if (item.topic) return item.topic;
  if (typeof item.front === "string") return item.front;
  return `Item ${index + 1}`;
}



/** Display shape only. Reference/option/support quality is checked by the shared
 * plugin boundary inside the session, where an ungraded skip remains available. */
export function validatePluginData(type: PluginType, item: StudyItem): string | null {
  if ((type === "three-stage" || type === "spelling") && !item.word) return "词汇内容缺少单词。";
  if (["quiz", "recall", "calculation", "code"].includes(type) && !item.prompt) return "学习内容缺少题干。";
  if (type === "flashcard" && item.front === undefined) return "翻转卡缺少正面内容。";
  return null;
}
