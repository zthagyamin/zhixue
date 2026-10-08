import {appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {stripVTControlCharacters} from 'node:util';

// Never infer success from a historical count or an absent result.
export function tapTotals(log) {
  const text = stripVTControlCharacters(log);
  const totals = {};
  for (const field of ['tests', 'pass', 'fail', 'cancelled', 'skipped', 'todo']) {
    const matches = [...text.matchAll(new RegExp('^# ' + field + ' (\\d+)\\s*$', 'gm'))];
    totals[field] = matches.length ? Number(matches.at(-1)[1]) : null;
  }
  return totals;
}

export function fullPassed(totals, outcome) {
  return outcome === 'success' && Number.isInteger(totals.tests) && totals.tests >= 1672 &&
    totals.pass === totals.tests && ['fail', 'cancelled', 'skipped', 'todo'].every(key => totals[key] === 0);
}

export function browserPassed(report, expected, sha, outcome) {
  return outcome === 'success' && Number.isInteger(expected) && expected > 0 &&
    typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha) &&
    report?.sha === sha && report.complete === true && report.failure === null &&
    report.expected === expected && report.passed === expected &&
    Array.isArray(report.results) && report.results.length === expected &&
    report.results.every(result => result.passed === true);
}

export function gatePassed(needs) {
  return !!needs && typeof needs === 'object' && !Array.isArray(needs) &&
    Object.hasOwn(needs, 'full') && Object.hasOwn(needs, 'browser') &&
    Object.values(needs).every(job => job?.result === 'success');
}

function safe(value) {
  return String(value ?? 'unknown').replace(/[\r\n|<>`]/g, ' ');
}
function summary(body) {
  const heading = `## 知学 CI\n\n分支 / PR ref：\`${safe(process.env.GITHUB_REF)}\`  \n实际验证提交：\`${safe(process.env.GITHUB_SHA)}\`  \n事件：\`${safe(process.env.GITHUB_EVENT_NAME)}\`；运行：${safe(process.env.GITHUB_RUN_ID)}；尝试：${safe(process.env.GITHUB_RUN_ATTEMPT)}\n\n`;
  const text = heading + body + '\n\n范围：隔离自动化验证，不是部署成功、线上全站验收或手机硬件验收。\n';
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
}
function save(directory, name, data) {
  mkdirSync(directory, {recursive: true});
  writeFileSync(join(directory, name), JSON.stringify(data, null, 2) + '\n');
}
function identity(directory) {
  const actual = execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
  if (!/^[0-9a-f]{40}$/.test(process.env.GITHUB_SHA || '') || actual !== process.env.GITHUB_SHA) {
    throw new Error('Checkout SHA differs from the workflow event; refusing to verify another tree');
  }
  const event = process.env.GITHUB_EVENT_PATH ? JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8')) : {};
  const data = {
    sha: actual, tree: execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {encoding: 'utf8'}).trim(),
    ref: process.env.GITHUB_REF, event: process.env.GITHUB_EVENT_NAME,
    runId: process.env.GITHUB_RUN_ID, attempt: process.env.GITHUB_RUN_ATTEMPT,
    prHeadSha: event.pull_request?.head?.sha || null, prBaseSha: event.pull_request?.base?.sha || null,
    node: process.version, platform: process.platform,
    python: process.env.pythonLocation || null, recordedAt: new Date().toISOString(),
  };
  save(directory, 'source-identity.json', data);
  console.log(JSON.stringify(data, null, 2));
}
function main() {
  const [mode, destination, count] = process.argv.slice(2);
  if (mode === 'gate') {
    const needs = JSON.parse(process.env.CI_NEEDS_JSON || '{}');
    const passed = gatePassed(needs);
    const rows = ['full', 'browser'].map(key => `| ${key === 'full' ? '完整校验' : '浏览器回归矩阵'} | ${safe(needs[key]?.result || 'missing')} |`).join('\n');
    summary(`**${passed ? '通过' : '未通过'}**\n\n| 检查 | 结果 |\n| --- | --- |\n${rows}\n\n只有全部必需任务成功，CI 总结果才通过。失败、取消、跳过或缺失结果都不算通过。请在失败任务的步骤与本次运行的 artifacts 中查看日志。`);
    process.exitCode = passed ? 0 : 1;
    return;
  }
  if (!destination) throw new Error('Usage: ci-report.mjs identity|full|browser DIRECTORY [EXPECTED]');
  const directory = resolve(destination);
  if (mode === 'identity') {identity(directory); return;}
  if (mode === 'full') {
    const path = join(directory, 'full-verification.log');
    const bytes = existsSync(path) ? readFileSync(path) : Buffer.alloc(0);
    const totals = tapTotals(bytes.toString('utf8'));
    const passed = fullPassed(totals, process.env.TEST_OUTCOME);
    const report = {sha: process.env.GITHUB_SHA, outcome: process.env.TEST_OUTCOME || 'missing', passed, totals, logSha256: createHash('sha256').update(bytes).digest('hex')};
    save(directory, 'verification-result.json', report);
    const rows = Object.entries(totals).map(([key, value]) => `| ${key} | ${value ?? '未取得'} |`).join('\n');
    summary(`### 完整 npm test：${passed ? '通过' : '未通过'}\n\n步骤状态：${safe(report.outcome)}。以下数字从本次原始日志提取，不使用旧记录。\n\n| 项目 | 数量 |\n| --- | ---: |\n${rows}\n\n日志 SHA-256：\`${report.logSha256}\`\n\n不以零失败替代完整性检查；必须有完整汇总、至少保留原有 1672 项覆盖，并且没有跳过、取消或 todo。日志中的 lint / build 警告仍需查看，不代表零警告。`);
    process.exitCode = passed ? 0 : 1;
    return;
  }
  if (mode === 'browser') {
    const path = join(directory, 'results.json');
    const report = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
    const expected = Number(count);
    const passed = browserPassed(report, expected, process.env.GITHUB_SHA, process.env.TEST_OUTCOME);
    save(directory, 'verification-result.json', {sha: process.env.GITHUB_SHA, passed, expected, actual: report?.passed ?? null, outcome: process.env.TEST_OUTCOME || 'missing'});
    summary(`### 浏览器回归：${passed ? '通过' : '未通过'}\n\n实际完成：**${report?.passed ?? '未取得'} / ${expected}**；步骤状态：${safe(process.env.TEST_OUTCOME)}。\n\n必须取得本次提交的完整结果，且每个场景明确通过。缺少 JSON、退出失败、SHA 不一致和未完成场景均不能通过。浏览器使用合成身份与本地夹具；外站请求被阻断。`);
    process.exitCode = passed ? 0 : 1;
    return;
  }
  throw new Error('Unknown CI report mode: ' + mode);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
