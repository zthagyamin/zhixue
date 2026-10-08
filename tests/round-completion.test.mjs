import { readServerSource } from './helpers/server-source.mjs';
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {renderToStaticMarkup} from 'react-dom/server';
import {dashboardFunction,dashboardJsxProp} from './fixtures/dashboard-functions.mjs';
import {loadTsx} from './fixtures/tsx-components.mjs';
const {StudyItemSource}=loadTsx(new URL('../app/study-item-source.tsx',import.meta.url));
import {readDashboardSource} from './helpers/dashboard-source.mjs';

// 学科本轮结束界面：词汇全部到阶段 3 或其他模块本轮全部答对后，学科页
// 必须渲染结束界面（统计 + 返回今日汇总 + 再学一轮），而不是卡在最后
// 一张卡或无限循环。

test("dashboard renders a per-subject round completion state with stats and actions", async () => {
  const source = await readDashboardSource();
  assert.match(source, /subjectRoundComplete/);
  assert.match(source, /「\{subject\.name\}」本组已完成/);
  assert.match(source, /返回今日汇总/);
  assert.match(source, /再学一轮/);
  assert.match(source, /restartSubjectRound/);
});

test("non-vocabulary subjects no longer loop the queue forever after the last item", async () => {
  const source = await readDashboardSource();
  assert.doesNotMatch(source, /\(\(current\[subject\.id\] \|\| 0\) \+ 1\) % items\.length/);
});

test("vocabulary restart replays each word reset through the study attempt pipeline", async () => {
  const source = await readDashboardSource();
  const restart=dashboardFunction('restartSubjectRound',{}).toString();
  assert.match(source,/restartSubjectRound/);
  assert.match(restart,/rating:\s*['"]again['"]/);
  assert.match(restart,/stageAfter:\s*0\b/);
  assert.match(restart,/isThreeStage:\s*true\b/);
});

test("completion screen offers wrong-item-only re-practice and an FSRS interval hint", async () => {
  const source = await readDashboardSource();
  assert.match(source, /只重练答错的 \{round\.wrongKeys\.length\} 项/);
  assert.match(source, /restartSubjectRound\(subject\.id, round\.wrongKeys\)/);
  assert.match(source, /FSRS 复习间隔会相应缩短/);
  assert.match(source, /focusRound/);
});

test("today view celebrates when every module completes and badges finished module cards", async () => {
  const source = await readDashboardSource();
  assert.match(source, /allSubjectsComplete/);
  assert.match(source, /今天的每一个模块都已完成/);
  assert.match(source, /已完成本轮 ✓/);
});

test("due review session ends with a settlement summary instead of silently closing", async () => {
  const source = await readDashboardSource();
  assert.match(source, /setPracticeSummary\(summary\)/);
  assert.match(source, /本轮复习完成/);
  assert.match(source, /再来一轮/);
});

test("explained panel offers a Socratic AI tutor follow-up through the companion hint channel", async () => {
  const [session, dashboard, tutorComponent] = await Promise.all([
    readFile(new URL("../app/practice-session.tsx", import.meta.url), "utf8"),
    readDashboardSource(),
    readFile(new URL("../app/plugins/tutor-follow-up.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(tutorComponent, /问 AI 导师/);
  assert.match(tutorComponent, /askTutor/);
  assert.match(session, /<TutorFollowUp askTutor=\{context\?\.askTutor\} item=\{activeItem\} \/>/);
  assert.match(dashboard, /async function requestAiTutor/);
  assert.match(dashboard, /userQuestion: question, item/);
  assert.match(dashboard, /askTutor:accountLoaded\?.*requestAiTutor/g);
});

test("subject plugins render MathText formulas and a tutor follow-up on explanations", async () => {
  const [quiz, calculation, recall] = await Promise.all([
    readFile(new URL("../app/plugins/plugin-quiz.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/plugin-calculation.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/plugin-recall.tsx", import.meta.url), "utf8"),
  ]);
  for (const [name, source] of [["quiz", quiz], ["calculation", calculation], ["recall", recall]]) {
    assert.match(source, /<MathText /, name + " 讲解应走 MathText");
    assert.match(source, /<TutorFollowUp askTutor=/, name + " 讲解应有 AI 导师追问");
  }
});

test("explanations render LaTeX through katex-backed MathText", async () => {
  const [mathText, session] = await Promise.all([
    readFile(new URL("../app/math-text.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/practice-session.tsx", import.meta.url), "utf8"),
  ]);
  assert.ok(mathText.includes("katex.renderToString"), "MathText 应调用 katex.renderToString");
  assert.ok(mathText.includes("katex/dist/katex.min.css"), "MathText 应引入 katex 样式");
  assert.match(session, /<MathText text=\{activeItem\.explanation/);
});

test("progress tab renders a learning effectiveness dashboard from FSRS state and events", async () => {
  const [dashboard, eventsModule, progressView] = await Promise.all([
    readDashboardSource(),
    readFile(new URL("../app/local-study-events.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/study-progress-overview.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(eventsModule, /export async function listWorkspaceStudyEvents/);
  assert.match(dashboard, /readNativeStudyHistory\(workspaceId,submissionJournal,/);
  const {dashboardJsxProp}=await import('./fixtures/dashboard-functions.mjs');
  const fsrsData={a:{due:'2026-09-08T00:00:00Z'}};
  assert.equal(dashboardJsxProp('StudyProgressOverview','fsrsData',{uiProgress:{fsrsData}}),fsrsData);
  assert.match(progressView,/forecastDue\(/);
  assert.match(dashboard, /riskRanking\(\{ fsrsData: uiProgress\.fsrsData/);
  assert.match(dashboard, /accuracyByKey\(progressEvents\)/);
  assert.match(dashboard, /aria-label="学习效果"/);
  assert.match(dashboard, /最需要巩固 · 记忆保留率最低/);
  assert.match(dashboard, /作答正确率 · 全部历史/);
});

test("settings gives users connection controls before source management", async () => {
  const source=await readDashboardSource();
  const panel=await readFile(new URL('../app/note-sources-panel.tsx',import.meta.url),'utf8');
  assert.ok(source.indexOf('<CompanionSettingsCard')<source.indexOf('<div id="note-source-entry">'));
  for(const label of ['Obsidian 文件夹','单个学习文件','Notion 导出 ZIP','Notion 在线页面'])assert.ok(panel.includes(label));
  assert.match(panel,/href="#companion-pairing"/);
});

test("focused study retains the actual source title and scope in its source panel", async () => {
  const server=await readServerSource();
  const html=renderToStaticMarkup(dashboardJsxProp('StudySessionShell','source',{
    StudyItemSource,currentItem:{},data:{source:{title:'论文甲 · 第三节',scope:'已登记的阅读材料',path:'collection.md'}},
    accountLoaded:true,companionSession:null,syncState:'offline',
    workspaceId:'account:fixture',accountLibraryId:'fixture-library',
    getObsidianUri(){throw new Error('An unlocated item cannot open a collection file');},
  }));
  assert.match(html,/论文甲 · 第三节/);
  assert.match(html,/已登记的阅读材料/);
  assert.match(html,/本题出处：尚未定位/);
  assert.doesNotMatch(html,/来源已定位|已定位到所属笔记|href="obsidian:/);
  assert.match(html,/需要本机已安装 Obsidian/);
  assert.match(server, /prompt 必须自带文章标识/);
});

test("vocabulary is paced in 20-word daily groups with a free-choice override", async () => {
  const [pacing, dashboard, db] = await Promise.all([
    readFile(new URL("../app/vocab-pacing.ts", import.meta.url), "utf8"),
    readDashboardSource(),
    readFile(new URL("../app/local-study-db.ts", import.meta.url), "utf8"),
  ]);
  assert.ok(pacing.includes("DEFAULT_VOCAB_QUOTA = 20"), "默认每日 20 词");
  assert.ok(pacing.includes("export function splitGroupBounds"));
  assert.ok(pacing.includes("export function resolveServedGroup"));
  assert.ok(dashboard.includes("splitGroupBounds(allItems.length, isVocabPaced ? selectedVocabReference?.groupQuota ?? vocabPacing.settings.quota : allItems.length)"), "已保存计划使用生成时词量，无计划时可自由调整");
  assert.ok(dashboard.includes("词库分组：第"));
  assert.ok(dashboard.includes("每日词量"));
  assert.ok(dashboard.includes("复习词条（计划内）"), "单词复习条目不伪装成第 1 组");
  assert.ok(dashboard.includes("继续下一组"));
  assert.ok(dashboard.includes("vocab-pacing"));
  assert.ok(db.includes("vocab-pacing"));
});
test("learning actions live on the today view, settings stays data-only", async () => {
  const source = await readFile(new URL('../app/study-dashboard/sources-view.tsx',import.meta.url),'utf8');
  const todayView = await readFile(new URL('../app/study-dashboard/today-view.tsx',import.meta.url),'utf8');
  const composition = await readFile(new URL('../app/study-dashboard/dashboard-view.tsx',import.meta.url),'utf8');
  assert.match(composition, /<TodayView model=\{model\}/);
  assert.match(composition, /<SourcesView model=\{model\.sourcesModel\}/);
  const connectionsStart = source.indexOf('sourceView === "connections"');
  const privacyStart = source.indexOf('sourceView === "privacy"');
  const connectionsView = source.slice(connectionsStart, privacyStart);
  for (const marker of ["c-legacy-plan-board", "计划设置 · 用户约束", "去背词", "去做题", "<PracticeSession"]) {
    assert.ok(todayView.includes(marker), "今日汇总应包含：" + marker);
    assert.ok(!connectionsView.includes(marker), "数据与设置不应包含：" + marker);
  }
  assert.ok(connectionsView.includes("复习状态 · 只读诊断"), "诊断属于数据页");
  const settingsView=source.slice(source.indexOf('tab === "sources" && <section'),privacyStart);
  assert.ok(settingsView.includes("<NoteSourcesPanel"), "接入入口属于设置页");
});
