// QA only: real account handlers, synthetic material, in-memory SQLite, no providers.
// The same frozen input definitions can be used against a baseline or a candidate.
import {createHash, randomBytes} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {parseArgs} from 'node:util';

export const BASELINE_SHA = '923028a53df83158fccb7c53e7a256ab5a4fa578';
export const SCENARIOS = Object.freeze([
  {id: 'quiz-multiple', questionType: 'quiz', title: '基线 · 多选：主张与证据'},
  {id: 'paper-recall', questionType: 'recall', title: '基线 · 论文回忆：dropout 的作用'},
  {id: 'guided-maths', questionType: 'calculation', title: '基线 · 数学：展开后求值'},
  {id: 'nonvocab-flashcard', questionType: 'flashcard', title: '基线 · 非词汇卡：数据泄漏'},
].map(Object.freeze));

function portValue(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Invalid fixture port');
  return port;
}
export function scenarioLinks(port, scenario = 'all') {
  const selected = scenario === 'all' ? SCENARIOS : SCENARIOS.filter(row => row.id === scenario);
  if (!selected.length) throw Error('Unknown nonword scenario');
  const first = portValue(port);
  if (first + selected.length - 1 > 65535) throw Error('Invalid fixture port range');
  return selected.map((row, index) => ({...row, port: first + index,
    href: `http://127.0.0.1:${first + index}/study?nonwordFixture=${row.id}`,
    status: `http://127.0.0.1:${first + index}/__fixture/status`}));
}
export function loopbackCsp(port, devPort) {
  const local = `http://127.0.0.1:${portValue(devPort)}`;
  const socket = `ws://127.0.0.1:${portValue(devPort)}`;
  portValue(port);
  return `default-src 'self'; script-src 'self' ${local} 'unsafe-inline' 'unsafe-eval'; ` +
    `style-src 'self' 'unsafe-inline'; connect-src 'self' ${local} ${socket}; ` +
    "img-src 'self' data: blob:; font-src 'self' data:; worker-src 'self' blob:; " +
    "object-src 'none'; frame-src 'none'; base-uri 'self'; form-action 'self'";
}

const moduleAt = (repo, path) => import(pathToFileURL(resolve(repo, path)).href);
export async function inspectSource(repo, role = 'candidate') {
  if (!['baseline', 'candidate'].includes(role)) throw Error('Source role must be baseline or candidate');
  const git = args => execFileSync('git', ['-c', `safe.directory=${repo}`, ...args], {cwd: repo, encoding: 'utf8'}).trim();
  const sha = git(['rev-parse', 'HEAD']);
  const dirty = git(['diff', '--name-only', 'HEAD']).split(/\r?\n/).filter(Boolean);
  const pkg = JSON.parse(await readFile(resolve(repo, 'package.json'), 'utf8'));
  const tree = git(['rev-parse', 'HEAD^{tree}']);
  const manifest=JSON.parse(await readFile(resolve(repo,'tests/fixtures/public-baseline.json'),'utf8'));
  const files=manifest.files.map(([file])=>file).sort();
  const observed=[];
  for(const file of files)observed.push([file,createHash('sha256').update((await readFile(resolve(repo,file),'utf8')).replaceAll('\r\n','\n')).digest('hex')]);
  const observedDigest=createHash('sha256').update(JSON.stringify(observed)).digest('hex');
  const baselineSourceDigest=manifest.digest;
  const unchanged=observedDigest===manifest.digest;
  if (role === 'baseline' && (!unchanged || dirty.length || pkg.version !== manifest.version))
    throw Error('Immutable baseline requires clean, frozen public source; use a separate baseline checkout');
  return {role, sha, tree, baselineSourceDigest, baselineSourceUnchanged:unchanged, version: pkg.version, dirty, devServerSource: 'operator-must-match-repo'};
}

function scenarioBody(row) {
  const itemKey = `nonword:${row.id}`, sourceHash = createHash('sha256').update('nonword-baseline-20261005-v1').digest('hex');
  const common = {schemaVersion: 2, kind: 'practice', itemKey, eventKind: 'due', subjectId: row.id,
    title: row.title, sourceHash, completionRule: 'graded-practice'};
  const practice = {itemId: itemKey, abilityId: itemKey, domain: row.id === 'paper-recall' ? 'paper' : 'course',
    questionType: row.questionType, sourceLabel: '隔离合成材料 · 非真实学习资料'};
  if (row.id === 'quiz-multiple') return {...common, practice: {...practice,
    prompt: '这段合成实验报告说：控制其他训练条件后，加入 dropout 的验证误差降低。请选择报告支持的全部判断。',
    explanation: 'A 是报告观察；B 保留了实验条件。C 把单次观察扩展成所有数据与所有模型的保证，超出了材料。'},
    learningSupport: {schemaVersion: 1, type: 'quiz', selection: 'multiple', options: [
      {optionId: 'A', text: '这个实验中验证误差降低'},
      {optionId: 'B', text: '结论依赖报告所控制的训练条件'},
      {optionId: 'C', text: 'dropout 在所有模型上一定改善验证误差', trapType: 'out_of_scope',
        trapExplanation: '报告只有给定实验条件下的结果，不能推出普遍保证。'},
    ], correctOptionIds: ['A', 'B']}};
  if (row.id === 'paper-recall') return {...common, practice: {...practice,
    prompt: '针对这段合成论文材料：dropout 训练时暂时丢弃部分隐藏单元。请解释它如何降低共适应，并说明这不是哪些结论的保证。',
    answer: '训练时暂时丢弃部分隐藏单元，迫使特征避免只依赖固定的其他单元；这是降低共适应的一种正则化方法，但不保证所有数据与模型都改善泛化。',
    explanation: '核对机制：临时丢弃 → 减少固定依赖；核对边界：不把给定方法解释当作普遍泛化保证。'},
    learningSupport: {schemaVersion: 1, type: 'recall', criteria: [
      {id: 'mechanism', text: '解释暂时丢弃单元使特征减少对固定搭档的依赖', mandatory: true},
      {id: 'boundary', text: '说明不保证所有数据与模型上泛化都改善', mandatory: true},
    ], hints: ['从训练时改变哪些依赖想起。', '连接临时丢弃、固定依赖和泛化结论的边界。',
      '暂时丢弃部分隐藏单元可降低固定单元间的共适应，但不保证所有数据与模型上的泛化改善。']}};
  if (row.id === 'guided-maths') return {...common, practice: {...practice,
    prompt: '实数 x = 1。先展开 (x + 1)^2，再求它的数值。填写最终结果。', answer: '4',
    explanation: '(x + 1)^2 = x^2 + 2x + 1；x = 1 时为 1 + 2 + 1 = 4。'},
    learningSupport: {schemaVersion: 1, type: 'calculation', mode: 'numeric', domain: 'real', variables: [], tolerance: '0'}};
  return {...common, practice: {...practice,
    prompt: '为什么在评估泛化时，要避免验证集信息进入训练或模型选择之外的测试步骤？',
    answer: '信息泄漏让评估样本影响了待评估系统，结果可能高估对真正未见样本的表现。划分用途应在实验前明确，并区分训练、选择与最终测试。',
    explanation: '这是合成的概念卡；自评反映当前回忆难度，不等于延迟掌握。'},
    learningSupport: {schemaVersion: 1, type: 'flashcard', mode: 'bidirectional', direction: 'forward', parentId: 'synthetic-concept-parent'}};
}

export async function createNonwordAccount({repo, origin, scenario, day = '2026-10-05'}) {
  const url = new URL(origin);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') throw Error('Fixture requires http loopback');
  portValue(url.port);
  const row = SCENARIOS.find(entry => entry.id === scenario);
  if (!row) throw Error('Unknown nonword scenario');
  const [{createAccountPreview}, {createAccountStudyClient}, {sealStudyItem, sealStudySnapshot},
    {snapshotBody}, planning, {generateTaskPlan}, {editTaskPlan}] = await Promise.all([
    moduleAt(repo, 'tests/fixtures/account-preview.mjs'), moduleAt(repo, 'app/account-study-client.ts'),
    moduleAt(repo, 'app/account-study-content.ts'), moduleAt(repo, 'tests/fixtures/account-study-fixtures.mjs'),
    moduleAt(repo, 'app/account-study-planning.ts'), moduleAt(repo, 'app/task-plan-engine.ts'), moduleAt(repo, 'app/task-plan-edit.ts'),
  ]);
  const userId = createHash('sha256').update(`synthetic-nonword:${scenario}`).digest('hex');
  const account = await createAccountPreview({origin, userId, day, scenario: 'account-writeback'});
  const token = randomBytes(32).toString('base64url');
  async function post(action, body = {}, machine = true) {
    const response = await account.handle(new Request(origin + '/api/account-study', {method: 'POST',
      headers: {'content-type': 'application/json', Origin: origin, ...(machine ? {Authorization: `Bearer ${token}`} : {})},
      body: JSON.stringify({action, ...body})}));
    const value = await response.json();
    if (!response.ok) throw Error(`Synthetic seed ${action}: ${response.status} ${JSON.stringify(value)}`);
    return value;
  }
  try {
    await account.registerDevice({grantId: 'synthetic-nonword-grant', libraryId: 'library-a',
      tokenHash: createHash('sha256').update(token).digest('hex'), label: 'Synthetic nonword QA'});
    await post('activate-grant');
    const item = await sealStudyItem(scenarioBody(row)), items = [item];
    const snapshot = await sealStudySnapshot(snapshotBody(items, {snapshotId: `synthetic-${scenario}`,
      sourceHash: item.sourceHash, generatedAt: `${day}T00:00:00.000Z`}));
    await post('begin-snapshot', {snapshot});
    await post('stage-items', {snapshotId: snapshot.snapshotId, entries: [{position: 0, item}]});
    await post('complete-snapshot', {snapshotId: snapshot.snapshotId, expectedRevision: 0});
    const native = {schemaVersion: 1, sourceHash: item.sourceHash, diagnostics: [],
      subjects: [{subjectId: item.subjectId, name: row.title, priority: 1, planningStatus: 'none', words: [], units: [], goals: []}],
      practiceSources: [{itemKey: item.itemKey, subjectId: item.subjectId, title: item.title,
        sourceHash: item.sourceHash, completionRule: item.completionRule}]};
    const {catalog} = await planning.toCloudPlanningCatalog(native, {snapshot, items});
    await post('publish-planning-catalog', {catalog});
    const facts = await planning.sealCloudPlanningFacts({schemaVersion: 1, libraryId: 'library-a',
      snapshotId: snapshot.snapshotId, catalogHash: catalog.catalogHash, observedAt: `${day}T00:00:00.000Z`,
      nativePlanRevision: 0, sourceReviews: [], captureReviews: [], legacyEvents: [], legacyTaskEvents: [],
      contentCandidates: [], historyComplete: true});
    await post('publish-planning-facts', {facts});
    const engine = await planning.toEnginePlanningCatalog(catalog);
    let plan = await generateTaskPlan({day, catalog: engine, words: [], reviews: [], completions: [], previous: null});
    plan = await editTaskPlan(plan, {type: 'upsert', task: {taskId: `synthetic:${scenario}`, subjectId: item.subjectId,
      title: item.title, category: 'subject', origin: 'manual', required: false, unitIds: [], quantity: 1,
      action: {kind: 'practice', itemKeys: [item.itemKey]}, completionRule: item.completionRule,
      sourceHash: engine.practiceSources.find(entry => entry.itemKey === item.itemKey).sourceHash}}, engine);
    const cloud = await planning.sealCloudTaskPlan(plan, catalog, {baseRevision: 0, factsHash: facts.factsHash,
      eventThrough: 0, taskThrough: 0, nativeBaseRevision: 0});
    await post('mutate-plan', {mutation: {action: 'save', operationId: 'synthetic-save', expectedRevision: 0, plan: cloud}}, false);
    await post('mutate-plan', {mutation: {action: 'approve', operationId: 'synthetic-approve', expectedRevision: 1,
      day, planHash: cloud.cloudPlanHash, predecessorOperationId: null}}, false);
    const client = createAccountStudyClient({companionUrl: origin, expectedUserId: userId, cache: null,
      fetcher: (path, init) => account.handle(new Request(new URL(path, origin),
        {...init, headers: {...init?.headers, Origin: origin}}))});
    await client.load();
    const status = async () => {
      const loaded = await client.load(), state = await client.getPlanState(day), inspect = account.inspect();
      const recordCounts = {};
      for (const {record} of loaded.records) {
        const key = record.provenanceMode === 'task' ? 'task:unrated' : `${record.practiceMode}:${record.event.attempt.rating}`;
        recordCounts[key] = (recordCounts[key] ?? 0) + 1;
      }
      return {scope: 'synthetic-in-memory-only', scenario, baselineSha: BASELINE_SHA, userId, libraryId: 'library-a', day,
        counts: {items: loaded.bundle.items.length, tasks: state.approvedPlan.tasks.length, records: inspect.records,
          assistance: inspect.assistance, assistanceReceipts: inspect.assistanceReceipts,
          aiRequests: inspect.aiRequests.reduce((sum, value) => sum + value.count, 0)},
        recordCounts, externalModels: 'blocked', realNotes: 'blocked', browserAcceptance: 'unrun'};
    };
    return {...account, client, status};
  } catch (error) { account.close(); throw error; }
}

export async function startNonwordBaselinePreview({repo, port = 3050, devPort = 3012, scenario = 'all', role = 'baseline'}) {
  const source = await inspectSource(repo, role), links = scenarioLinks(port, scenario);
  const {startAccountPagePreview} = await moduleAt(repo, 'tests/fixtures/automatic-day-preview.mjs');
  const previews = [];
  try {
    for (const link of links) {
      const account = await createNonwordAccount({repo, origin: new URL(link.href).origin, scenario: link.id});
      const intercept = async (req, res) => {
        res.setHeader('Content-Security-Policy', loopbackCsp(link.port, devPort));
        res.setHeader('X-Nonword-Fixture-Source', `${role}:${source.sha}`);
        const url = new URL(req.url, link.href);
        if (url.pathname === '/__fixture/status' || url.pathname === '/__fixture/scenarios') {
          if (req.method !== 'GET') { res.writeHead(405); res.end(); return true; }
          const value = url.pathname.endsWith('status') ? {...await account.status(), source, links} : {source, links};
          res.writeHead(200, {'content-type': 'application/json', 'cache-control': 'no-store'});
          res.end(JSON.stringify(value)); return true;
        }
        return false;
      };
      try {
        previews.push(await startAccountPagePreview({account, client: account.client, port: link.port,
          devPort: portValue(devPort), intercept}));
      } catch (error) { account.close(); throw error; }
    }
    return {source, links, close: async () => { for (const preview of previews) await preview.close(); }};
  } catch (error) { for (const preview of previews) await preview.close(); throw error; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const {values} = parseArgs({options: {
    repo: {type: 'string'}, port: {type: 'string'}, 'dev-port': {type: 'string'},
    scenario: {type: 'string'}, role: {type: 'string'},
  }});
  if (!values.repo) throw Error('Pass --repo for the actual source tree and run a matching dev server separately');
  const preview = await startNonwordBaselinePreview({repo: resolve(values.repo),
    port: values.port ?? process.env.PORT ?? 3050, devPort: values['dev-port'] ?? process.env.DEVPORT ?? 3012,
    scenario: values.scenario ?? 'all', role: values.role ?? 'baseline'});
  console.log(JSON.stringify({scope: 'synthetic-in-memory-only', source: preview.source, links: preview.links}, null, 2));
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {await preview.close(); process.exit(0);});
}
