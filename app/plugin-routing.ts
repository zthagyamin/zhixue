import type {LearningSupport} from './learning-support';
// @ts-expect-error TS5097: Node tests require explicit TypeScript extension.
import {parsePaperStudyData,type PaperStudyData} from './paper-study.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {PLUGIN_TYPES,wordRecallContent,hasExecutableCodeMaterial} from '../src/domain/content/index.ts';
import type {PracticeMode as PluginType} from '../src/domain/content/index';
export {PLUGIN_TYPES};
export type {PracticeMode as PluginType} from '../src/domain/content/index';
export type ItemPluginOverride = PluginType | "ai";

export type PluginOverrides = {
  subject: Record<string, PluginType>;
  item: Record<string, ItemPluginOverride>;
};

export type RoutableStudyItem = {
  learningSupport?:LearningSupport;
  paper?:PaperStudyData;
  id?: string;
  pluginType?: PluginType;
  type?: PluginType;
  word?: string;
  phonetic?: string;
  meaning?: string;
  context?: string;
  example?: string;
  prompt?: string;
  options?: string[];
  answer?: string;
  explanation?: string;
  reviewPoint?: string;
  initialCode?: string;
  testCode?: string;
  solutionCode?: string;
  front?: unknown;
  back?: unknown;
  sourceNote?: string;
  stateRef?: string;
  abilityId?: string;
};

export const emptyPluginOverrides: PluginOverrides = { subject: {}, item: {} };

export const pluginLabels: Record<PluginType, string> = {
  "three-stage": "三阶段背词",
  quiz: "单项选择",
  recall: "AI 回忆问答",
  calculation: "计算题",
  code: "编程沙箱",
  flashcard: "自评闪卡",
  spelling: "拼写练习",
  paper: "论文精读",
};

export function isPluginType(value: unknown): value is PluginType {
  return typeof value === "string" && (PLUGIN_TYPES as readonly string[]).includes(value);
}

export function isVocabularySubject(subject: {pluginType?: string; items: Array<{word?: string}>}): boolean {
  return ['three-stage', 'spelling'].includes(subject.pluginType ?? '') && subject.items.some(item => Boolean(item.word));
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function recommendedPluginType(item: RoutableStudyItem, subjectType: PluginType): PluginType {
  return item.pluginType || item.type || subjectType;
}

export function adaptStudyItemForPlugin(type: PluginType, item: RoutableStudyItem): RoutableStudyItem | null {
  if(item.learningSupport&&item.learningSupport.type!==type)return null;
  if(type==='paper'){try{return item.paper?{...item,paper:parsePaperStudyData(item.paper)}:null;}catch{return null;}}
  if (type === "three-stage") {
    return hasText(item.word) && hasText(item.meaning) && hasText(item.example) ? item : null;
  }

  if (type === "spelling") {
    return hasText(item.word) && hasText(item.meaning) ? item : null;
  }

  if (type === "quiz") {
    if(item.learningSupport?.type==='quiz')return hasText(item.prompt)?item:null;
    return hasText(item.prompt) && hasText(item.answer) && Array.isArray(item.options) && item.options.length >= 2 ? item : null;
  }

  if (type === "recall") {
    if (hasText(item.prompt)) return item;
    if (item.front !== undefined && item.back !== undefined) {
      return { ...item, prompt: String(item.front), explanation: String(item.back) };
    }
    if (hasText(item.word) && hasText(item.meaning)) {
      return {
        ...item,
        ...wordRecallContent(item)!,
      };
    }
    return null;
  }

  if (type === "calculation") {
    return hasText(item.prompt) && (typeof item.answer === "number" || hasText(item.answer) || item.pluginType === "calculation") ? item : null;
  }

  if (type === "code") {
    return hasText(item.prompt) && hasExecutableCodeMaterial(item) ? item : null;
  }

  if (item.front !== undefined && item.back !== undefined) return item;

  if (hasText(item.word) && hasText(item.meaning)) {
    return {
      ...item,
      front: [item.word, item.phonetic].filter(hasText).join("  "),
      back: [item.meaning, item.context, item.example].filter(hasText).join("\n\n"),
    };
  }

  if (hasText(item.prompt) && (hasText(item.answer) || hasText(item.solutionCode))) {
    return {
      ...item,
      front: item.prompt,
      back: [item.answer || item.solutionCode, item.explanation].filter(hasText).join("\n\n"),
    };
  }

  if (hasText(item.word) && (hasText(item.sourceNote) || hasText(item.stateRef))) {
    const source = item.sourceNote || item.stateRef;
    return {
      ...item,
      front: item.word,
      back: `先完成主动回忆，再打开来源笔记核对：${source}`,
    };
  }

  return null;
}

export function compatiblePluginTypes(item: RoutableStudyItem): PluginType[] {
  return PLUGIN_TYPES.filter((type) => adaptStudyItemForPlugin(type, item) !== null);
}

export function resolvePluginType(
  item: RoutableStudyItem,
  subjectType: PluginType,
  itemOverride?: ItemPluginOverride,
  subjectOverride?: PluginType,
): PluginType {
  const recommended = recommendedPluginType(item, subjectType);
  const compatible = new Set(compatiblePluginTypes(item));

  if (itemOverride === "ai") return compatible.has(recommended) ? recommended : compatible.values().next().value || recommended;
  if (itemOverride && compatible.has(itemOverride)) return itemOverride;
  if (subjectOverride && compatible.has(subjectOverride)) return subjectOverride;
  return compatible.has(recommended) ? recommended : compatible.values().next().value || recommended;
}

export function pluginItemKey(subjectId: string, item: RoutableStudyItem, index: number): string {
  const identity = hasText(item.id) ? item.id : hasText(item.word) ? item.word.toLocaleLowerCase("en-US") : String(index);
  return `${subjectId}::${identity}`;
}

export function normalizePluginOverrides(value: unknown): PluginOverrides {
  if (!value || typeof value !== "object") return { subject: {}, item: {} };
  const source = value as { subject?: unknown; item?: unknown };
  const subject: Record<string, PluginType> = {};
  const item: Record<string, ItemPluginOverride> = {};

  if (source.subject && typeof source.subject === "object") {
    for (const [key, plugin] of Object.entries(source.subject)) {
      if (isPluginType(plugin)) subject[key] = plugin;
    }
  }
  if (source.item && typeof source.item === "object") {
    for (const [key, plugin] of Object.entries(source.item)) {
      if (plugin === "ai" || isPluginType(plugin)) item[key] = plugin;
    }
  }

  return { subject, item };
}

export function prunePluginOverrides(overrides: PluginOverrides, subjectIds: readonly string[]): PluginOverrides {
  const valid = new Set(subjectIds.filter((id): id is string => typeof id === "string" && id.length > 0));
  const subject: Record<string, PluginType> = {};
  const item: Record<string, ItemPluginOverride> = {};

  for (const [key, plugin] of Object.entries(overrides.subject)) {
    if (valid.has(key)) subject[key] = plugin;
  }
  for (const [key, plugin] of Object.entries(overrides.item)) {
    if (valid.has(key.split("::")[0])) item[key] = plugin;
  }

  const unchanged =
    Object.keys(subject).length === Object.keys(overrides.subject).length &&
    Object.keys(item).length === Object.keys(overrides.item).length;

  return unchanged ? overrides : { subject, item };
}
