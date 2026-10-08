import type {RecallAttemptScope} from '../recall-attempt-state';
import type { ReactNode } from "react";
import { createLazyPlugin } from './lazy-plugin';
import type {LearningDraftAdapter} from '../learning-draft-store';
import type {PaperServices} from './plugin-paper';
import type {NonWordLearningPort,NonWordHostScope} from '../../src/application/nonword-study';

import type {FSRSRating,GradePayload} from '../../src/domain/assessment/index';
export type {FSRSRating,GradePayload} from '../../src/domain/assessment/index';

export interface PluginContext {
  /** Host-only paired native course service; plugins use the controlled course lifecycle. */
  nativeCourse?: import('../../src/application/course-study').NativeCourseTransport;
  nativeMath?: import('../../src/domain/math-study').NativeMathTransport;
  /** Opt-in original non-vocabulary lifecycle; absent for vocabulary and old callers. */
  nonWordLearning?:NonWordLearningPort;
  nonWordScope?:NonWordHostScope;
  nonWordNavigation?:{continuePending:()=>void;resumeFormal:(rating:FSRSRating)=>void;restoreRound?:(state:import('../../src/application/nonword-study').NonWordRoundState)=>boolean};
  /** Page-local quality navigation; never a learning event or a stored field. */
  contentNavigation?: {onSkip:()=>void};
  /** Authoritative original content prevents a display-mode switch bypassing checks. */
  contentSource?: {mode:import('../plugin-routing').PluginType;data:unknown};
  /** Device-only teaching preference, scoped by the already resolved workspace owner. */
  guidanceScope?: string;
  /** The host exposes full instructions in its learning options panel. */
  guidanceInOptions?: boolean;
  recallScope?:RecallAttemptScope;
  recallPersistenceRequired?:boolean;
  /** Host-owned, page-only traversal. Skip must never create a learning event. */
  recallNavigation?: { continueLabel: '下一题' | '结束本轮'; onSkip: () => void };
  paperServices?:PaperServices;
  /** Public content identity, never a source path or persisted draft identifier. */
  aiItem?:{id:string;title:string;question?:string};
  /** Current page's temporary input buffer; never part of a learning event. */
  draft?:LearningDraftAdapter;
  requestAiHint?: (data: unknown, selectedOption: string | null) => Promise<string>;
  /** 针对讲解的引导式追问：用户自由提问，AI 导师按苏格拉底风格回答，不落学习流。 */
  askTutor?: (question: string, item: unknown) => Promise<string>;
  /** 带会话认证的判题调用（Companion 客户端），插件不得裸 fetch。 */
  gradeCalculation?: (item: unknown, answer: string, signal?:AbortSignal) => Promise<GradePayload>;
  /** 带会话认证的回忆判题调用；非词汇弃权由宿主保留答案与待核对状态。 */
  gradeRecall?: (item: unknown, answer: string, signal?: AbortSignal) => Promise<GradePayload>;
}

export type PluginGradeOptions = { deferAdvance?: boolean; continuationReceipt?:boolean; identity?:{eventId:string;reviewedAt:string} };

export interface PluginRenderProps<TData> {
  data: TData;
  onGrade: (rating: FSRSRating, options?: PluginGradeOptions) => void | Promise<unknown>;
  context?: PluginContext;
}

export interface StudyPlugin<TData = unknown> {
  id: string;
  name: string;
  description: string;
  renderUI: (props: PluginRenderProps<TData>) => ReactNode;
}

class PluginRegistry {
  private plugins = new Map<string, StudyPlugin<unknown>>();

  register<TData>(plugin: StudyPlugin<TData>) {
    if (this.plugins.has(plugin.id)) {
      console.warn(`Plugin ${plugin.id} is already registered. Overwriting.`);
    }
    this.plugins.set(plugin.id, plugin as unknown as StudyPlugin<unknown>);
  }

  get<TData = unknown>(id: string): StudyPlugin<TData> | undefined {
    return this.plugins.get(id) as StudyPlugin<TData> | undefined;
  }

  getAll(): StudyPlugin<unknown>[] {
    return Array.from(this.plugins.values());
  }
}

export const registry = new PluginRegistry();

// Task 6: 注册回忆题与计算题插件
registry.register(createLazyPlugin({id:'@zhixue/plugin-recall',name:'回忆题',description:'先主动回忆，再由 AI 按核心要点给出完整、部分或需重学的反馈。'},async()=>(await import('../plugin-recall')).RecallPlugin));
registry.register(createLazyPlugin({id:'@zhixue/plugin-calculation',name:'计算题',description:'输入数值或表达式结果，由 Companion 判定正误。'},async()=>(await import('../plugin-calculation')).CalculationPlugin));
