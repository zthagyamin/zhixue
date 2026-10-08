import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import {createLearningDraftStore} from '../app/learning-draft-store.ts';
import * as viewApi from '../app/study-view-model.ts';
import * as roundApi from '../app/subject-round.ts';
import * as contentApi from '../src/domain/content/index.ts';
import * as nonWordApplication from '../src/application/nonword-study/index.ts';
import * as extraRoundApi from '../src/features/nonword-study/extra-round.ts';
import {nativeScopeReference} from '../src/infrastructure/course-study/native-scope.ts';

// These are isolated state/component-callback tests, not a browser or DOM test.
const root = new URL('../', import.meta.url);
const jsx = (type, props, key) => ({ type, props: props ?? {}, key });
const runtime = { jsx, jsxs: jsx, Fragment: Symbol('Fragment') };
function load(path, mocks = {}) {
  const text = readFileSync(new URL(path, root), 'utf8');
  const result = ts.transpileModule(text, { fileName: path, reportDiagnostics: true,
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } });
  assert.equal((result.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error).length, 0, path);
  const exports = {};
  const require = name => {
    if (name === 'react/jsx-runtime') return runtime;
    if (Object.hasOwn(mocks, name)) return mocks[name];
    if (name === '../src/domain/content') return contentApi;
    if (name === '../../src/infrastructure/course-study') return {nativeScopeReference};
    if (name === './study-dashboard/nonword-plugin-host') return nonWordHostApi;
    if (name === '../src/application/nonword-study') return nonWordApplication;
    if (name === '../src/features/nonword-study') return extraRoundApi;
    if (name === './study-dashboard/nonword-round-cache') return {useNonWordRoundCache:()=>forbiddenRecovery};
    throw new Error(`Unexpected dependency in isolated test: ${path}: ${name}`);
  };
  new Function('require', 'exports', result.outputText)(require, exports);
  return exports;
}
function hooks() {
  const slots = []; let cursor = 0;
  return { reset: () => { cursor = 0; }, react: {
    useState(initial) { const id = cursor++; if (!(id in slots)) slots[id] = typeof initial === 'function' ? initial() : initial;
      return [slots[id], value => { slots[id] = typeof value === 'function' ? value(slots[id]) : value; }]; },
    useRef: value => ({ current: value }), useEffect: () => {},useLayoutEffect:()=>{},useId:()=> 'fixture-id',
    useMemo(factory) { const id=cursor++;if(!(id in slots))slots[id]=factory();return slots[id]; },
  } };
}
// Execute the real legacy seam. These older snapshots have no recovery scope,
// so entering any durable runtime or formal writer is an unexpected side effect.
const forbiddenRecovery=()=>{throw Error('A no-scope UX fixture must not enter durable recovery');};
const scopeApi=load('app/study-dashboard/nonword-scopes.ts',{
  '../account-study-runtime':{resolveAccountStudyItem:forbiddenRecovery},
  '../practice-order':{practiceGroup:forbiddenRecovery},'../dynamic-ui-model':{stableStudyItemKey:forbiddenRecovery},
});
const nonWordHostApi=load('app/study-dashboard/nonword-plugin-host.tsx',{
  react:{useRef:forbiddenRecovery},'../math-text':{MathText:forbiddenRecovery},
  '../recall-flow-model':{recallReference:forbiddenRecovery},
  '../study-submission-journal':{createSubmissionJournal:forbiddenRecovery},
  '../local-study-events':{getLocalStudyEvent:forbiddenRecovery},
  '../assistance-observer':{createAssistanceObserver:forbiddenRecovery,emptyAssistanceObserverState:forbiddenRecovery},
  '../../src/domain/content':contentApi,'../../src/features/nonword-study':{NonWordStudyHost:forbiddenRecovery},
  '../../src/features/course-study':{CourseInteraction:forbiddenRecovery},
  '../../src/infrastructure/course-study':{portableCourseTask:forbiddenRecovery,attachPortableCourseDriver:forbiddenRecovery},
  '../../src/infrastructure/practice-evidence':{attachPracticeDriver:forbiddenRecovery,createAccountMathClient:forbiddenRecovery},
  '../../src/infrastructure/math-study':{nativeMathTask:forbiddenRecovery,attachNativeMathDriver:forbiddenRecovery,attachAccountMathDriver:forbiddenRecovery},
  '../account-study-content':{parseStudyItem:forbiddenRecovery,parseStudySnapshot:forbiddenRecovery},
  '../../src/domain/math-study':{resolveCalculationReferenceSupport:forbiddenRecovery},
  '../../src/features/course-study/course-study.css':{},
  '../../src/infrastructure/nonword-study':{createNonWordRuntime:forbiddenRecovery,recoveryFields:forbiddenRecovery,rawAnswer:forbiddenRecovery,restoredFields:forbiddenRecovery,evaluationPhase:forbiddenRecovery},
  '../../src/features/nonword-study/study.css':{},
  '../../src/application/nonword-study':nonWordApplication,
  './nonword-scopes':scopeApi,'./nonword-round-cache':{},'./nonword-services':{},
});
test('real no-scope host seam forwards legacy props and a word override cannot enter durable recovery',()=>{
  const PluginUI=()=>null,data={prompt:'A'},onGrade=()=>{},context={draft:{},contentSource:{mode:'quiz',data}};
  const props={plugin:{id:'@zhixue/plugin-quiz',renderUI:PluginUI},data,context,onGrade};
  const legacy=nonWordHostApi.NonWordPluginHost(props);
  assert.equal(legacy.type,PluginUI);assert.equal(legacy.props.context,context);assert.equal(legacy.props.data,data);assert.equal(legacy.props.onGrade,onGrade);
  const overridden=nonWordHostApi.NonWordPluginHost({...props,context:{...context,nonWordScope:{temporary:true},contentSource:{mode:'quiz',data:{word:'tree',meaning:'树'}}}});
  assert.equal(overridden.type,PluginUI);assert.equal(overridden.props.data,data);assert.equal(overridden.props.onGrade,onGrade);
});
function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes);
  if (!tree || typeof tree !== 'object') return [];
  return [tree, ...nodes(tree.props?.children)];
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join('');
  if (tree == null || typeof tree === 'boolean') return '';
  return typeof tree === 'object' ? text(tree.props?.children) : String(tree);
}
const stateApi = load('app/extra-practice-state.ts');
const obsidianApi = load('app/obsidian-link.ts');
const sourceApi = load('app/study-item-source-model.ts', {'./obsidian-link.ts':obsidianApi});
const sourceHooks=hooks();
const { StudyItemSource } = load('app/study-item-source.tsx', {react:sourceHooks.react,'./study-item-source-model':sourceApi,'./obsidian-link':obsidianApi,'./clipboard':{copyTextSafely:async()=>false},'./ux-remedies.css':{}});
function sourceActions(tree){const node=nodes(tree).find(value=>typeof value.type==='function'&&value.type.name==='SourceNoteActions');assert.ok(node,'Located notes render their scoped source actions');sourceHooks.reset();return node.type(node.props);}

for (const threeStage of [false, true]) test(`extra practice: fresh state and full completion, threeStage=${threeStage}`, () => {
  const official = Object.freeze({ stages: Object.freeze([3, 3]), events: Object.freeze(['existing-event']) });
  let state = stateApi.createExtraPracticeState(2);
  assert.equal(state.complete, false); assert.deepEqual(state.stages, [0, 0]);
  const initial = state;
  for (let i = 0; i < (threeStage ? 6 : 2); i++) state = stateApi.advanceExtraPractice(state, { index: state.index, revision: state.revision, threeStage, rating: 'good' });
  assert.equal(state.complete, true); assert.deepEqual(state.stages, [3, 3]);
  assert.deepEqual(initial.stages, [0, 0]); assert.deepEqual(official.stages, [3, 3]); assert.deepEqual(official.events, ['existing-event']);
});
test('extra practice ignores duplicate/late callbacks, retries a single card, and rejects an empty set', () => {
  assert.throws(() => stateApi.createExtraPracticeState(0));
  const first = stateApi.createExtraPracticeState(1);
  const request = { index: 0, revision: 0, threeStage: true, rating: 'again' };
  const next = stateApi.advanceExtraPractice(first, request);
  assert.equal(next.complete, false); assert.equal(next.revision, 1);
  assert.equal(stateApi.advanceExtraPractice(next, request), next);
  assert.equal(stateApi.advanceExtraPractice(next, { ...request, index: 2, revision: 1 }), next);
});

test('source panel does not mistake a collection path for the current question source', () => {
  let opened = 0;
  const tree = StudyItemSource({ item: {}, source: { title: '课程资料', scope: '全部笔记', path: 'Notes/course.md' }, canOpenLocal: false, getObsidianUri: () => { opened++; return ''; } });
  assert.match(text(tree), /本题出处：尚未定位/);
  assert.doesNotMatch(text(tree), /来源已定位|已定位到所属笔记/); assert.equal(opened, 0);
  assert.equal(nodes(tree).filter(n => n.type === 'a').length, 0);
  assert.equal(tree.props['data-ai-private'], true);
});
for (const note of ['invalid', 'https://example.org/course.md', 'javascript:lesson.md', 'notes.md?query=x', 'bad\npath.md']) test(`source rejects invalid local reference: ${JSON.stringify(note)}`, () => {
  assert.equal(sourceApi.resolveItemSource({ sourceNote: note }).kind, 'unlocated');
});
test('source precision distinguishes description, note, and an explicit section', () => {
  assert.equal(sourceApi.resolveItemSource({ sourceLabel: '第六讲' }).kind, 'label');
  assert.equal(sourceApi.resolveItemSource({ sourceNote: 'Notes/a.md', sourceLabel: '第六讲' }).kind, 'document');
  const section = sourceApi.resolveItemSource({ sourceNote: 'Notes/a.md#卷积公式' });
  assert.equal(section.kind, 'section'); assert.equal(section.section, '卷积公式'); assert.equal(section.notePath, 'Notes/a.md');
  let target;
  const tree = StudyItemSource({ item: { sourceNote: 'Notes/a.md#卷积公式' }, source: { title: '课程', scope: '' }, canOpenLocal: true, getObsidianUri: path => { target = path; return `obsidian:${path}`; } });
  const actions=sourceActions(tree);assert.equal(target, 'Notes/a.md#卷积公式');assert.match(text([tree,actions]), /小节 \/ 锚点：卷积公式/);
  assert.equal(sourceApi.resolveItemSource({}).kind, 'unlocated');
});

const { DashboardFocusHero } = load('app/dashboard-focus-hero.tsx', { react: { useEffect: () => {} } });
const tasks = [ { taskId: 'a', title: 'A', action: { kind: 'practice' }, estimatedMinutes: 5 }, { taskId: 'b', title: 'B', action: { kind: 'practice' }, estimatedMinutes: 13 } ];
for (const startedTaskIds of [[], ['b']]) test(`duration follows the selected or resumed task: ${startedTaskIds}`, () => {
  const input = { ready: true, tasks, completedTaskIds: [], startedTaskIds };
  const lead = viewApi.selectStudyTask(input); const summary = viewApi.studyFocusSummary(input);
  const tree = DashboardFocusHero({ lead, summary, disabled: false, onStart() {}, onAdvanced() {} });
  assert.match(text(tree), new RegExp(`本组预计 ${startedTaskIds.length ? 13 : 5} 分钟`));
  assert.match(text(tree), /合计预计 18 分钟/);
});
test('duration skips blocked/completed tasks and preserves unknown estimates', () => {
  const input = { ready: true, tasks: [{ ...tasks[0], blockedReason: 'changed' }, tasks[1]], completedTaskIds: [], startedTaskIds: [] };
  assert.equal(viewApi.selectStudyTask(input).estimatedMinutes, 13);
  assert.equal(viewApi.selectStudyTask({ ...input, completedTaskIds: ['b'] }), null);
  const lead = viewApi.selectStudyTask({ ...input, tasks: [{ ...tasks[1], estimatedMinutes: NaN }] });
  assert.equal(lead.estimatedMinutes, undefined);
  const tree = DashboardFocusHero({ lead, summary: { groups: 1, minutes: null, blocked: 0 }, disabled: false, onStart() {}, onAdvanced() {} });
  assert.match(text(tree), /按自己的节奏完成/); assert.doesNotMatch(text(tree), /NaN|Infinity|本组预计 0/);
});
test('legacy duration input remains supported', () => {
  const tree = DashboardFocusHero({ lead: { taskId: 'a', title: 'A', kind: 'next' }, summary: { groups: 2, minutes: 18, leadMinutes: 5, blocked: 1 }, disabled: false, onStart() {}, onAdvanced() {} });
  assert.match(text(tree), /本组预计 5 分钟/); assert.match(text(tree), /1 组资料需要核对/);
});

function subjectHarness(pluginType, partialLibrary = false) {
  const hook = hooks(); const calls = [];
  const PluginUI = () => null;
  const extraMock = { ExtraPracticeSession: function ExtraPracticeSession() {} };
  const imports = new Proxy({}, { get: (_target, name) => name === '__esModule' ? true : () => null });
  const source = readFileSync(new URL('app/study-dashboard/subject-view.tsx', root), 'utf8');
  const parsed = ts.createSourceFile('subject.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const mocks = {};
  for (const statement of parsed.statements) if (ts.isImportDeclaration(statement)) mocks[statement.moduleSpecifier.text] = imports;
  Object.assign(mocks, {
    './nonword-plugin-host':{...nonWordHostApi,useNonWordRoundCache:()=>forbiddenRecovery},
    react: hook.react, '../extra-practice-session': extraMock, '../study-item-source': { StudyItemSource },
    '../subject-round': roundApi,
    '../account-study-runtime': { resolveModuleTaskScope: () => null },
    '../dynamic-ui-model': { resolveStudyItemProgressKey: item => item.id, modulePresentation: () => ({ eyebrow: 'TEST' }) },
    '../plan-runtime': { planItemStages: (_entry, _subjects, progress) => progress.itemStages },
    '../learning-draft-store': { learningDraftItemId: (_subject, key) => key },
    '../plugins': { registry: { get: () => ({ renderUI: PluginUI }) } },
    '../plugin-routing': { PLUGIN_TYPES: [pluginType], isVocabularySubject: subject => subject.pluginType === 'three-stage',
      adaptStudyItemForPlugin: (_mode, item) => ({ ...item }), pluginItemKey: (_subject, item) => item.id,
      compatiblePluginTypes: () => [pluginType], recommendedPluginType: () => pluginType, resolvePluginType: () => pluginType },
    '../vocab-pacing': { pacingForSubject: () => ({ settings: { quota: 2 }, serve: {} }),
      splitGroupBounds: (size, quota) => Array.from({ length: Math.ceil(size / quota) }, (_, i) => ({ start: i * quota, end: Math.min(size, (i + 1) * quota) })),
      firstIncompleteGroup: () => 0, resolveServedGroup: () => 0 },
    './prelude': { validatePluginData: () => null, itemLabel: item => item.id, domainForSubject: () => 'test', itemKindForDomain: () => 'due' },
  });
  const { SubjectView } = load('app/study-dashboard/subject-view.tsx', mocks);
  const items = [{ id: 'a', prompt: 'A' }, { id: 'b', prompt: 'B' }, ...(partialLibrary ? [{ id: 'c', prompt: 'C' }] : [])];
  const subject = { id: 'unit', name: '测试学科', pluginType, items };
  const model = { tab: 'unit', workspaceId: 'account:test', currentDay: '2026-09-12', isDemoMode: false,
    accountModeEpoch: { current: 0 }, practiceRequest: { current: 0 }, accountLoaded: null,
    moduleNavigationSubjects: [subject], moduleSubjects: [subject], normalizedSubjects: [subject], subjects: [subject],
    data: { source: { title: '课程', scope: '本机' }, localLibraryId: 'library-a' },
    nativeView: { ready: true, unresolvedKeys: [] }, taskLearning: {},
    uiProgress: { itemStages: { a: 3, b: 3 }, fsrsData: { a: { due: 'unchanged' } } },
    itemIndices: { unit: 1 }, pluginOverrides: { item: {}, subject: {} },
    subjectRounds: { unit: { correctKeys: ['a', 'b'], wrongKeys: ['b'], resets: 1 } },
    getVisibleSubjectRound: id => ({ scope:'synthetic-round', round:model.subjectRounds[id] }),
    learningDrafts: { isPending: () => false, adapter: () => ({}) },
    restartSubjectRound: async (...args) => {calls.push(['reset', ...args]);}, setItemIndex: (...args) => calls.push(['index', ...args]),
    getObsidianUri: path => `obsidian:${path}`, setPlanMessage: message => calls.push(['message', message]),
  };
  const render = () => { hook.reset(); const shell = SubjectView({ model }); return shell.type(shell.props); };
  return { model, calls, render, ExtraPracticeSession: extraMock.ExtraPracticeSession };
}
for (const [mode, partial] of [['quiz', false], ['three-stage', false], ['three-stage', true]]) test(`completed subject enters an independent extra session: ${mode}, partial=${partial}`, () => {
  const h = subjectHarness(mode, partial); const before = structuredClone(h.model.uiProgress);
  const button = nodes(h.render()).find(n => n.type === 'button' && text(n) === '再巩固一遍');
  assert.ok(button); button.props.onClick();
  const session = nodes(h.render()).find(n => n.type === h.ExtraPracticeSession);
  assert.ok(session, 'a completed view must actually be replaced by the extra session');
  assert.equal(session.props.snapshot.items.length, 2); assert.deepEqual(h.calls, []); assert.deepEqual(h.model.uiProgress, before);
  session.props.onExit(); assert.ok(nodes(h.render()).some(n => n.type === 'button' && text(n) === '再巩固一遍'));
});
test('extra practice snapshot is not shown in another account/library', () => {
  const h = subjectHarness('quiz'); nodes(h.render()).find(n => text(n) === '再巩固一遍' && n.type === 'button').props.onClick();
  h.model.workspaceId = 'account:other';
  assert.equal(nodes(h.render()).some(n => n.type === h.ExtraPracticeSession), false);
});
test('explicit reset requires confirmation and cancel makes no state change', () => {
  const h = subjectHarness('three-stage'); const button = nodes(h.render()).find(n => n.type === 'button' && n.props['data-study-action'] === 'restart-round');
  const previous = globalThis.window;
  try {
    globalThis.window = { confirm: message => { assert.match(message, /记错/); return false; } };
    button.props.onClick(); assert.deepEqual(h.calls, []);
    globalThis.window.confirm = () => true; button.props.onClick();
    assert.deepEqual(h.calls, [['reset', 'unit', ['a', 'b']]]);
  } finally { globalThis.window = previous; }
});
test('wrong-item drill stays isolated while explicit wrong-item restart requires confirmation', () => {
  const h = subjectHarness('three-stage');
  const before = structuredClone(h.model.uiProgress);
  const drill = nodes(h.render()).find(n => n.type === 'button' && text(n) === '只重练答错的 1 项');
  drill.props.onClick();
  const extra = nodes(h.render()).find(n => n.type === h.ExtraPracticeSession);
  assert.deepEqual(extra.props.snapshot.items.map(item => item.id), ['b']);
  assert.deepEqual(h.calls, []);assert.deepEqual(h.model.uiProgress, before);
  extra.props.onExit();
  const screen = h.render();
  const details = nodes(screen).filter(n => n.type === 'details').find(d => nodes(d).some(n => n.props?.['data-study-action'] === 'restart-round'));
  const restart = nodes(details).find(n => n.type === 'button' && n.props['data-study-action'] === 'restart-wrong-items');
  assert.ok(restart, 'normal wrong-item restart must remain inside the collapsed options');
  assert.notEqual(details.props.open, true);
  const previous = globalThis.window;
  try {
    globalThis.window = { confirm: message => { assert.match(message, /仅重新开始本轮答错的 1 项/);return false; } };
    restart.props.onClick();assert.deepEqual(h.calls, []);
    globalThis.window.confirm = () => true;restart.props.onClick();
    assert.deepEqual(h.calls, [['reset', 'unit', ['b']]]);
  } finally { globalThis.window = previous; }
});
test('source, long-term and sync shortcuts target the corresponding settings groups', () => {
  const source = readFileSync(new URL('app/study-dashboard/dashboard-view.tsx', root), 'utf8');
  assert.match(source, /aria-label="查看数据源" onClick=\{\(\) => openSources\("sources"\)\}/);
  assert.match(source, /onClick=\{\(\)=>openSources\('sync'\)\}>查看同步状态/);
  assert.match(source, /onConnectSources=\{\(\)=>\{setTab\('sources'\);setSourceView\('sources'\)/);
  assert.match(source, /setAiEntryOpen\(false\);setTab\('sources'\);setSourceView\('sources'\)/);
});

test('extra session component grades only its local state and completes without persistence', () => {
  const hook = hooks(); const PluginUI = () => null;
  const { ExtraPracticeSession } = load('app/extra-practice-session.tsx', {
    react: hook.react, './plugins': { registry: { get: () => ({ renderUI: PluginUI }) } },
    './plugin-routing': { adaptStudyItemForPlugin: (_mode, item) => ({ ...item }), pluginLabels: { quiz: '选择题' } },
    './calculation-client': { gradeCalculationInWorker: () => { throw new Error('not used'); } },
    './extra-practice-state': stateApi, './study-item-source': { StudyItemSource },
    './study-guidance': { StudyGuidanceHelp: () => null },
    './study-plugin-options': { StudyPluginOptionsProvider: ({ children }) => children, StudyPluginOptionsSlot: () => null },
    './review-context': {ReviewContext:()=>null},
    './learning-draft-store': {createLearningDraftStore}, './learning-draft': {LearningDraftBoundary:()=>null,LearningDraftLeaveGuard:()=>null},
  });
  const snapshot = Object.freeze({ title: '测试', items: Object.freeze([{ prompt: 'A' }]), modes: ['quiz'], source: { title: '课程', scope: '' } });
  let exits = 0;
  const render = () => { hook.reset(); return ExtraPracticeSession({ snapshot, onExit: () => exits++, canOpenLocal: false, getObsidianUri: () => '' }); };
  const plugin = nodes(render()).find(n => n.type === PluginUI);
  assert.ok(plugin); assert.equal(typeof plugin.props.context.draft.begin, 'function'); assert.equal(plugin.props.context.recallScope, undefined);
  assert.equal(plugin.props.context.recallPersistenceRequired, false);
  plugin.props.onGrade('good'); plugin.props.onGrade('good');
  const finished = render(); assert.match(text(finished), /本轮巩固完成/);
  nodes(finished).find(n => n.type === 'button' && text(n) === '返回本轮完成页').props.onClick();
  assert.equal(exits, 1); assert.equal(snapshot.items[0].stage, undefined);
});

for(const count of [1,2])for(const rating of ['good','again'])test(`extra calculation ${rating}, ${count} items: feedback stays until continue`,()=>{
 const hook=hooks(),PluginUI=()=>null;
 const {ExtraPracticeSession}=load('app/extra-practice-session.tsx',{
  react:hook.react,'./plugins':{registry:{get:()=>({renderUI:PluginUI})}},
  './plugin-routing':{adaptStudyItemForPlugin:(_mode,item)=>({...item}),pluginLabels:{calculation:'计算题'}},
  './calculation-client':{gradeCalculationInWorker:()=>{throw new Error('No grading replay');}},
  './extra-practice-state':stateApi,'./study-item-source':{StudyItemSource},
  './study-guidance':{StudyGuidanceHelp:()=>null},
  './study-plugin-options':{StudyPluginOptionsProvider:({children})=>children,StudyPluginOptionsSlot:()=>null},
  './review-context':{ReviewContext:()=>null},
  './learning-draft-store':{createLearningDraftStore},'./learning-draft':{LearningDraftBoundary:()=>null,LearningDraftLeaveGuard:()=>null},
 });
 const snapshot={scopeKey:'isolated',title:'计算',items:Array.from({length:count},(_,i)=>({prompt:String(i)})),modes:Array(count).fill('calculation'),source:{title:'本地',scope:''}};
 const render=()=>{hook.reset();return ExtraPracticeSession({snapshot,onExit(){},canOpenLocal:false,getObsidianUri:()=>''});};
 const original=nodes(render()).find(n=>n.type===PluginUI);original.props.context.draft.write('result',{correct:rating==='good',explanation:'不能闪掉'});
 original.props.onGrade(rating,{deferAdvance:true});original.props.onGrade(rating,{deferAdvance:true});
 const held=nodes(render()).find(n=>n.type===PluginUI);assert.ok(held);assert.equal(held.key,original.key);
 assert.equal(held.props.data.prompt,'0');assert.equal(held.props.context.draft.hasSavedFeedback(),true);
 assert.equal(held.props.context.draft.continueAfterFeedback(),true);assert.equal(held.props.context.draft.continueAfterFeedback(),false);
 const next=render();if(count===1&&rating==='good')assert.match(text(next),/本轮巩固完成/);else assert.notEqual(nodes(next).find(n=>n.type===PluginUI).key,original.key);
});
test('restoring previously completed words never claims a perfect first attempt',()=>{
 const h=subjectHarness('three-stage');h.model.subjectRounds={};
 const body=text(h.render());assert.match(body,/此前已完成/);assert.doesNotMatch(body,/全部一次通过|全部首次答对/);
});
