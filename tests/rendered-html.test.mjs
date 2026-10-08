import { readServerSource } from './helpers/server-source.mjs';
import {attachNavigationBindings} from './fixtures/causal-controller-bindings.mjs';
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dashboardFunction, dashboardClick, dashboardModuleKey } from './fixtures/dashboard-functions.mjs';
import {readDashboardSource} from './helpers/dashboard-source.mjs';

async function render(path = "/", headers = {}) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${path}`, { headers: { accept: "text/html", ...headers } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("server-renders the public landing page", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>知学 · 每日学习系统<\/title>/i);
  assert.match(html, /你的资料，训练/);
  assert.match(html, /登录并创建私人空间/);
  assert.match(html, /网站相同，学习空间各自独立/);
  assert.match(html, /启动或配对已有 Companion/);
  assert.match(html, /一键安装或更新/);
  assert.match(html, /Companion 的完整数据声明/);
  assert.match(html, /Obsidian 与普通笔记/);
});

test("recognizes a returning signed-in user on the landing page", async () => {
  const response = await render("/", {
    "oai-authenticated-user-id": "returning-user-001",
    "oai-authenticated-user-email": "learner@example.com",
    "oai-authenticated-user-full-name": encodeURIComponent("博羿"),
    "oai-authenticated-user-full-name-encoding": "percent-encoded-utf-8",
  });
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /继续我的学习/);
  assert.match(html, /继续学习/);
  assert.match(html, /已识别为.*博羿/);
  assert.doesNotMatch(html, /登录并创建私人空间/);
});

test("anonymous production study routes redirect home with the Companion destination intact", async () => {
  for(const [path,location] of [['/study','/'],['/study?pair=1','/?companionPort=43121'],['/study?pair=1&companionPort=43125','/?companionPort=43125']]){
    const response=await render(path);assert.equal(response.status,307);assert.equal(response.headers.get('location'),location);
    assert.doesNotMatch(await response.text(),/公开示例|本地游客|正在确认学习空间/);
  }
});

test("server-renders an identity gate for signed-in visitors before any learning projection", async () => {
  const response = await render("/study", {"oai-authenticated-user-id":"signed-in-fixture","oai-authenticated-user-email":"fixture@example.invalid"});
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /正在确认学习空间/);
  assert.match(html, /确认身份之后，才会读取个人缓存/);
  assert.match(html, /class="study-workspace-gate"/);
  assert.doesNotMatch(html, /Python 基础知识|三阶段背词/);
  assert.doesNotMatch(html, /aria-label="到期差分复习"/);
  // Hydrated navigation/learning routes are covered by the real fixture and
  // actual component/callback tests; SSR must not invent a resolved guest.
  assert.doesNotMatch(html, /你现在看到的是公开示例|本地游客/);
});

test("homepage CTA targets the first playable personal module", async () => {
  const page = await readDashboardSource();
  let tab = 'today', scope = 'task', pending = 4;
  const env = { primarySubject: {id: 'first-playable'}, setFreeStudySubject() {}, setTab: value => tab = value,
    practiceRequest: { get current() { return pending; }, set current(value) { pending = value; } },
    setActiveTaskScope: value => scope = value, setPracticeItems() {}, setPracticeSummary() {}, setPracticeLoading() {},accountAttemptActiveRef:{current:false},accountPendingLoadedRef:{current:null},pendingLocalSourceRef:{current:null},accountLoadedRef:{current:null},applyAccountLoaded:async()=>{},setData(){},accountStudyPayload:value=>value,workspaceId:'test' };
  attachNavigationBindings(env);
  env.navigateToStudyTab = dashboardFunction('navigateToStudyTab', env);
  dashboardClick('开始学习', env)();
  assert.equal(tab, 'first-playable');
  assert.equal(scope, null);
  assert.ok(pending > 4, 'Free study cancels any pending task-specific practice start');
  assert.match(page, /subjects\.map\(\(subject/);
  assert.match(page, /今天的学习任务已完成/);
  assert.match(page, /const uiProgress = isDemoMode \? demoProgress : accountLoaded \? scopedAccountProgress\?\.progress\?\?emptyProgress : nativeView\.progress/);
  // Demo-only persistence is exercised through the actual callback in dashboard-durable-grade.test.mjs.
  assert.match(page, /<StudyWorkspaceNavigation[\s\S]*?onNavigate=\{navigateToStudyTab\}/);
});

test("keeps all requested learning and connection modules in source", async () => {
  const [landing, page, companion, localDatabase, companionConfig, companionReadme, protocolScript, threeStagePlugin, quizPlugin, codePlugin, pluginIndex] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readDashboardSource(),
    readServerSource(),
    readFile(new URL("../app/local-study-db.ts", import.meta.url), "utf8"),
    readFile(new URL("../companion/config.json", import.meta.url), "utf8"),
    readFile(new URL("../companion/README.md", import.meta.url), "utf8"),
    readFile(new URL("../companion/register-protocol.ps1", import.meta.url), "utf8"),
    readFile(new URL("../app/plugins/plugin-three-stage.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/plugins/plugin-quiz.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/plugins/plugin-code.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/plugins/index.ts", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(landing, /from ["']next\/link["']/);
  assert.doesNotMatch(page, /from ["']next\/link["']/);

  // Operational labels stay short; full teaching and mastery caveats remain retrievable.
  const guidance = await readFile(new URL("../app/study-guidance-content.ts", import.meta.url), "utf8");
  assert.match(threeStagePlugin, /stage === 1/);
  assert.match(threeStagePlugin, /stage === 2/);
  assert.match(threeStagePlugin, /data\.example/);
  assert.match(threeStagePlugin, /<StudyGuidance/);
  assert.match(guidance, /认义、语境和无提示回忆/);
  // Three-stage reveal/grade actions are exercised by three-stage-ui and quiet-study-ui.
  assert.match(guidance, /完成三阶段.*不等于已经正式掌握/);
  assert.match(page, /study-loop-pending-activities-v1/);
  assert.match(page, /sourceNote/);
  assert.match(page, /stateRef/);
  assert.match(page, /abilityId/);
  assert.match(page, /crypto\.randomUUID/);
  assert.match(page, /到期差分复习/);
  assert.match(page, /AI Knowledge Base/);
  assert.match(page, /模型 API/);
  assert.match(page, /signin-with-chatgpt/);
  assert.match(page, /一次性配对码/);
  const connectionCard=await readFile(new URL("../app/companion-settings-card.tsx",import.meta.url),"utf8");
  assert.match(connectionCard, /启动已安装 Companion/);
  assert.match(connectionCard, /在原目录更新/);
  assert.match(connectionCard, /zhixue-companion:\/\/start/);
  assert.match(connectionCard, /Zhixue-Companion-Setup\.exe/);
  assert.match(connectionCard, /下载后运行/);
  assert.match(companionReadme, /无需预装 Python、PowerShell 7 或 Obsidian/);
  assert.match(page, /dailySyncMs = 24 \* 60 \* 60 \* 1000/);
  assert.match(page, /companionReconnectMs = 5_000/);
  assert.match(page, /contentMode\?: "demo" \| "personal"/);
  assert.match(page, /data\.contentMode === "demo"/);
  assert.match(page, /<StudyAISettings\s*\/>/);
  assert.match(page, /createLocalStudyAIService/);
  assert.doesNotMatch(page, /async function saveDeepSeekKey/);
  assert.match(page, /companionHttp\.source\(frame\.connection!,kind,signal\)/);
  assert.match(page, /response\.httpStatus===401/);
  assert.match(page, /setCompanionRetryToken\(value=>value\+1\)/);
  assert.ok(page.includes("onSync={()=>void refreshSources()}"));
  assert.doesNotMatch(page, /disabled=\{refreshing \|\| syncState === "offline"\}/);
  assert.doesNotMatch(page, /45_000/);
  assert.match(page, /立即同步进度/);
  assert.match(page, /const \[sourceView, setSourceView\] = useState<SourceView>/);
  assert.match(page, /detectExistingCompanion=companionSource\.detect/);
  assert.match(page, /resolvePluginType\(currentItem, subject\.pluginType, itemOverride, subjectOverride\)/);
  assert.match(page, /本学科默认/);
  assert.match(page, /本题恢复资料默认方式/);
  assert.match(page, /切换只改变练习方式，不会清空本题进度/);
  assert.match(page, /saveWorkspaceRecord\(workspaceId, "plugin-overrides", pluginOverrides\)/);
  assert.match(localDatabase, /"plugin-overrides"/);
  assert.match(page, /registry\.get\(`@zhixue\/plugin-\$\{actualPluginType\}`\)/);
  assert.match(page, /context=\{\{[\s\S]{0,500}requestAiHint[\s\S]{0,500}gradeRecall/);
  assert.doesNotMatch(page, /const detectExistingCompanion = async \(\) => \{\}/);
  assert.doesNotMatch(page, /\("overview" as string\)/);
  assert.doesNotMatch(page, /eventType: "fsrs-grade"/);
  assert.match(pluginIndex, /registry\.register\(QuizPlugin\)/);
  assert.match(pluginIndex, /registry\.register\(PluginThreeStage\)/);
  assert.match(pluginIndex, /registry\.register\(FlashcardPlugin\)/);
  assert.match(pluginIndex, /registry\.register\(CodePlugin\)/);
  assert.match(quizPlugin, /requestAiHint/);
  assert.match(codePlugin, /data\.testCode/);
  assert.match(localDatabase, /indexedDB\.open/);
  assert.match(localDatabase, /workspaceId/);
  assert.match(companion, /Access-Control-Allow-Private-Network/);
  assert.match(companion, /installation_owner/);
  assert.match(companion, /X-Study-Loop-Session/);
  assert.match(companion, /system-credential-store/);
  assert.match(companion, /local_notes_root/);
  assert.match(companion, /SUPPORTED_NOTE_SUFFIXES/);
  assert.match(companion, /with_connections/);
  assert.match(companion, /"thinking": \{"type": "disabled"\}/);
  assert.match(companion, /"contentMode": "personal"/);
  assert.match(companion, /open_deepseek/);
  assert.match(companion, /grade_recall_deepseek/);
  assert.match(companion, /matched_points/);
  assert.match(companion, /只依据参考要点/);
  assert.match(companion, /当前 AI API 暂时无法访问/);
  assert.match(page, /provider_unavailable/);
  assert.match(companion, /Windows 桌面会话/);
  assert.doesNotMatch(companion, /"model": "deepseek-chat"/);
  assert.match(companion, /\/v1\/dashboard\/today/);
  assert.match(companion, /\/v1\/activity/);
  assert.match(companion, /website events never infer mastered/);
  assert.equal(JSON.parse(companionConfig).auto_sync_seconds, 86400);
  assert.match(companionReadme, /双击 `Zhixue-Companion-Setup\.exe`/);
  assert.match(protocolScript, /HKCU:\\Software\\Classes\\zhixue-companion/);
});

test("keeps plugin routing guarded and activity provenance backward compatible", async () => {
  const [dashboard, companion, companionTests] = await Promise.all([
    readDashboardSource(),
    readServerSource(),
    readFile(new URL("./test_companion.py", import.meta.url), "utf8"),
  ]);

  assert.match(dashboard, /validatePluginData\(actualPluginType, \(pluginData \|\| currentItem\) as StudyItem\)/);
  const keyContext={subject:{id:'vocab'},itemProgressKey:'word:tree',actualPluginType:'three-stage',currentStage:1,stageRoundBump:0};
  assert.notEqual(dashboardModuleKey(keyContext),dashboardModuleKey({...keyContext,stageRoundBump:1}),'The same unremembered word must reset the revealed answer');
  assert.match(dashboard, /domainForSubject\(subject\)/);
  assert.match(dashboard, /sourceNote: markdownNotePath\(currentItem\.sourceNote\) \|\| markdownNotePath\(data\.source\.path\)/);
  assert.match(dashboard, /stateRef: markdownNotePath\(currentItem\.stateRef\)/);
  assert.match(dashboard, /abilityId: resolveEventAbilityId\(currentItem, idx, uiProgress\)/);
  assert.match(dashboard, /Object\.entries\(progress\.wordStages \|\| \{\}\)/);
  assert.match(dashboard, /Object\.entries\(progress\.itemStages \|\| \{\}\)/);
  assert.match(dashboard, /if \(event\.numericValue !== undefined\)/);
  assert.match(companion, /payload\.get\("sourceNote"\) or payload\.get\("relatedNote"\)/);
  assert.match(companion, /"schemaVersion": 2/);
  assert.match(companionTests, /test_legacy_related_note_becomes_provenance_not_state_target/);
});

test("routes new grades through one v3 controller and keeps legacy drains", async () => {
  const dashboard = await readDashboardSource();
  assert.match(dashboard, /recordStudyAttempt/);
  assert.match(dashboard, /putLocalStudyEvent/);
  assert.match(dashboard, /updateStudyEventDelivery/);
  assert.match(dashboard, /sendV3ToCloud/);
  assert.match(dashboard, /sendV3ToCompanion/);
  assert.match(dashboard, /flushCloudOutbox/);
  assert.match(dashboard, /flushPendingActivities/);
  assert.doesNotMatch(dashboard, /queueCloudEvent\(/);
  assert.doesNotMatch(dashboard, /recordActivity\(/);
  // Legacy drains never synthesize v3 evidence because legacy payloads lack the original rating.
  assert.doesNotMatch(dashboard, /flushCloudOutbox[\s\S]{0,300}withStudyEventCoreHash/);
  assert.doesNotMatch(dashboard, /flushPendingActivities[\s\S]{0,300}withStudyEventCoreHash/);
});

test("manual sync always runs the cloud download pass and refreshes its diagnostic", async () => {
  const dashboard = await readDashboardSource();
  assert.match(dashboard, /useSyncCoordinator/);
  assert.match(dashboard, /retryUnsupported:\s*true/);
  assert.match(dashboard, /forceFullBootstrap:\s*true/);
  assert.match(dashboard, /run\('manual',frame/);
  assert.match(dashboard, /await frame\.bootstrap\(\)/);
  assert.match(dashboard, /await frame\.diagnostics\(\)/);
});

test("the daily plan card uses the deterministic scheduler and companion plan apply", async () => {
  const [dashboard, planClient, planning] = await Promise.all([
    readDashboardSource(),
    readFile(new URL("../app/companion-plan-client.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/application/planning/legacy-plan-actions.ts", import.meta.url), "utf8"),
  ]);
  assert.match(dashboard, /今日计划/);
  assert.match(dashboard, /generateTodayPlan/);
  assert.match(dashboard, /approveTodayPlan/);
  assert.match(dashboard, /buildPlanInput/);
  assert.match(dashboard, /useLegacyPlanning/);
  assert.match(planning, /generateDailyPlan/);
  assert.match(planning, /frame\.transport\.applyPlan/);
  assert.match(planClient, /v1\/plan\/apply/);
  assert.match(planClient, /expectedRevision/);
  assert.doesNotMatch(dashboard, /planHash[^}]{0,80}Date\.now\(\)/);
});

test("the source-area change review UI uses the audit-gated decide API", async () => {
  const [dashboard, planClient] = await Promise.all([
    readDashboardSource(),
    readFile(new URL("../app/companion-plan-client.ts", import.meta.url), "utf8"),
  ]);
  assert.match(dashboard, /资料变更/);
  assert.match(dashboard, /useSourceChanges/);
  assert.match(dashboard, /decideChange/);
  assert.match(planClient, /v1\/changes/);
  assert.match(planClient, /v1\/changes\/decide/);
  assert.match(dashboard, /companionPlanClient!\.decideChange/);
  assert.match(dashboard, /changeDecisionId/);
  assert.match(dashboard, /资料审批失败/);
  assert.match(dashboard, /"approved"|"rejected"|"later"/);
  assert.match(dashboard, /decision==='approved'[\s\S]{0,500}await ports\.source\(\)/);
  assert.match(dashboard, /companionHttp\.source\(companionSession!,'poll'/);
});

test("hides the codex capture card while retaining the capture data pipeline", async () => {
  const [dashboard, planClient, companion] = await Promise.all([
    readDashboardSource(),
    readFile(new URL("../app/companion-plan-client.ts", import.meta.url), "utf8"),
    readServerSource(),
  ]);
  // Task 7: the "Codex 捕获" card UI is hidden; the capture loading pipeline
  // (getCaptures → pendingCaptures state) and the client/server APIs remain.
  assert.doesNotMatch(dashboard, /Codex 捕获/);
  assert.match(dashboard, /pendingCaptures/);
  assert.match(dashboard, /getCaptures/);
  assert.match(planClient, /getCaptures: \(\) => get<CapturePayload>\("\/v1\/capture"\)/);
  assert.match(planClient, /initSources/);
  assert.match(planClient, /\/v1\/sources\/init/);
  assert.match(companion, /pendingCaptures/);
  assert.match(companion, /capture_store\.pending_captures\(database\)/);
});

test("keeps cloud progress isolated and privacy-balanced", async () => {
  const [hosting, schema, syncRoute, syncStore, syncUseCases, dashboard, studyEventV3] = await Promise.all([
    readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"),
    readFile(new URL("../src/infrastructure/database/schema.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/sync/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/infrastructure/sync-server/legacy-d1.ts", import.meta.url), "utf8"),
    readFile(new URL("../src/application/sync/legacy-requests.ts", import.meta.url), "utf8"),
    readDashboardSource(),
    readFile(new URL("../src/domain/evidence/study-event-v3.ts", import.meta.url), "utf8"),
  ]);

  assert.equal(JSON.parse(hosting).d1, "DB");
  assert.equal(JSON.parse(hosting).r2, null);
  assert.match(schema, /learning_accounts/);
  assert.match(schema, /learning_item_states/);
  assert.match(schema, /learning_progress_migrations/);
  assert.match(schema, /uidx_learning_events_user_event/);
  assert.match(schema, /onDelete: "cascade"/);
  assert.match(syncRoute, /getUser:\s*getChatGPTUser/);
  assert.match(syncRoute, /D1ReviewEventStore\(getDb\(\)\)/);
  assert.match(syncStore, /eq\(learningProgressMigrations\.userId, userId\)/);
  assert.match(syncStore, /eq\(learningEvents\.userId, userId\)/);
  assert.match(syncStore, /lastEventSequence/);
  assert.doesNotMatch(syncRoute+syncStore+syncUseCases, /body\.userId/);
  assert.doesNotMatch(schema, /api.?key|companion.?token|absolute.?path/i);
  assert.match(dashboard, /确认迁移进度/);
  assert.match(dashboard, /暂时只留本机/);
  assert.match(dashboard, /原始笔记和 API Key 不会上传/);

  // v3 cloud events keep local provenance out of cloud payloads: the shared
  // event module owns the forbidden-key gate, and the sync route never reads a
  // client-supplied user id for scoping.
  assert.match(studyEventV3, /FORBIDDEN_CLOUD_KEYS/);
  assert.match(studyEventV3, /"sourceNote"/);
  assert.match(studyEventV3, /"stateRef"/);
  assert.match(studyEventV3, /"vaultPath"/);
  assert.match(studyEventV3, /"localPath"/);
  assert.match(studyEventV3, /"apiKey"/);
  assert.match(studyEventV3, /"token"/);
  assert.doesNotMatch(syncRoute, /searchParams\.get\(["']userId["']\)/);
  assert.doesNotMatch(syncRoute, /sourceNote|stateRef|vaultPath|localPath/);
});

test("the practice session drives plugins with grade and variant", async () => {
  const [dashboard, session] = await Promise.all([
    readDashboardSource(),
    readFile(new URL("../app/practice-session.tsx", import.meta.url), "utf8"),
  ]);
  assert.match(session, /PracticeSession/);
  assert.match(session, /v1\/practice/);
  assert.match(session, /原题再练/);
  assert.doesNotMatch(session, /变式重考/);
  assert.match(session, /回到原笔记/);
  assert.match(dashboard, /去做题/);  // 计划条目直达练习（开始复习按钮已由计划条目取代）
  assert.doesNotMatch(dashboard, /Codex 捕获/);  // 捕获卡已隐藏
});
