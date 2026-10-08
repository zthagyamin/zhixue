import {registry} from './registry';
import {createLazyPlugin} from './lazy-plugin';

// Descriptors stay synchronous; implementation modules load only when rendered.
export const QuizPlugin=createLazyPlugin({id:'@zhixue/plugin-quiz',name:'选择题',description:'支持单选、多选、选项排除与来源解析。'},async()=>(await import('./plugin-quiz')).QuizPlugin);
export const PluginThreeStage=createLazyPlugin({id:'@zhixue/plugin-three-stage',name:'三阶段背词',description:'通过认识、推测、无提示自评三个阶段掌握词汇。'},async()=>(await import('./plugin-three-stage')).PluginThreeStage);
export const FlashcardPlugin=createLazyPlugin({id:'@zhixue/plugin-flashcard',name:'自评翻转卡片',description:'基于主动唤回原理的经典卡片模式，由用户自行评估记忆难度。'},async()=>(await import('./plugin-flashcard')).FlashcardPlugin);
export const CodePlugin=createLazyPlugin({id:'@zhixue/plugin-code',name:'实战编程题 (LeetCode Mode)',description:'提供一个类似于力扣的编程沙箱环境，用户必须编写通过所有断言测试的代码才能通关。'},async()=>(await import('./plugin-code')).CodePlugin);
export const SpellingPlugin=createLazyPlugin({id:'@zhixue/plugin-spelling',name:'拼写练习',description:'看释义与语境，逐字母打出单词（TypeWords 式打字拼写），训练 IELTS 写作拼写。'},async()=>(await import('./plugin-spelling')).SpellingPlugin);
export const PaperPlugin=createLazyPlugin({id:'@zhixue/plugin-paper',name:'论文精读',description:'微段选词、因果主线与审稿追问；不自动产生学习评分。'},async()=>(await import('./plugin-paper')).PaperPlugin);

// Bootstrap: 注册所有官方内置插件
registry.register(QuizPlugin);
registry.register(PluginThreeStage);
registry.register(FlashcardPlugin);
registry.register(CodePlugin);
registry.register(SpellingPlugin);
registry.register(PaperPlugin);

export { registry };
export * from "./registry";
export type {QuizData} from './plugin-quiz';
export type {FlashcardData} from './plugin-flashcard';
export type {CodeChallengeData} from './plugin-code';
