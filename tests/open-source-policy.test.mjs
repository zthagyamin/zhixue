import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync, spawnSync} from 'node:child_process';
import {mkdtemp, mkdir, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {normalizePublicPath, validatePolicy, validatePublicFiles, inspectPublicRepository} from '../scripts/open-source-policy.mjs';

const repo = fileURLToPath(new URL('../', import.meta.url));
const policy = JSON.parse(await readFile(join(repo, 'public-distribution-policy.json'), 'utf8'));
const digest = value => createHash('sha256').update(value).digest('hex');
const copy = value => structuredClone(value);

test('paths normalize separators but reject escape, ambiguous Windows paths and control characters', () => {
  assert.equal(normalizePublicPath('docs\\en\\FAQ.md'), 'docs/en/FAQ.md');
  for (const value of ['../x', 'a/../x', '/x', 'C:\\x', '//host/x', './x', 'a//x', 'a/./x', 'a/x.', 'a/x ', 'a:x', 'a\0x', 'a\nx', 'a/CON.txt']) {
    assert.throws(() => normalizePublicPath(value), /path/i, value);
  }
});

test('policy rejects unsupported versions, duplicate pins and broad exceptions', () => {
  assert.deepEqual(validatePolicy(policy), []);
  const newer = copy(policy); newer.schemaVersion = 2;
  assert.match(validatePolicy(newer).join('\n'), /schemaVersion/);
  const duplicate = copy(policy); duplicate.protectedFiles.push(copy(duplicate.protectedFiles[0]));
  assert.match(validatePolicy(duplicate).join('\n'), /duplicate/i);
  const wide = copy(policy); wide.archiveExceptions[0].path = 'tests/*';
  assert.match(validatePolicy(wide).join('\n'), /exception|path/i);
  for (const value of [null, {}, {map: 42}]) {
    const malformed = copy(policy); malformed.protectedFiles = value;
    assert.notDeepEqual(validatePolicy(malformed), []);
  }
});

async function publicFixture() {
  const files = new Map();
  for (const path of new Set([...policy.requiredFiles, ...policy.protectedFiles.map(row => row.path)])) {
    files.set(path, await readFile(join(repo, path)));
  }
  files.set('package.json', Buffer.from(JSON.stringify({license: policy.package.license,
    repository: policy.package.repository, scripts: policy.package.scripts})));
  files.set(policy.hosting.path, Buffer.from(JSON.stringify(policy.hosting.value)));
  files.set(policy.companionManifest, Buffer.from(JSON.stringify({schemaVersion: 1, files: ['LICENSE', 'THIRD_PARTY_NOTICES.md']})));
  return files;
}

test('valid public fixture keeps provenance, public hooks, neutral hosting and legal manifest entries', async () => {
  assert.deepEqual(validatePublicFiles(await publicFixture(), policy), []);
});

test('private operational paths, binaries, databases and local configuration fail including mixed case', async () => {
  const files = await publicFixture();
  for (const path of ['DOCS/Verification/result.md', 'docs/plans/private.md', 'CODEX_RELAY_note.md',
    'nested/DSH_RELAY_note.md', 'companion/data/state.sqlite3', 'data/store.db-wal',
    'public/downloads/runtime.ZIP', 'installer.MSI', 'nested/.env.production', '.openai/hosting.local.json',
    'nested/config.local.json', 'backup/private.pem', 'outputs/capture.png',
    '.codex-staging/state.json', 'test-results/screenshot.png', 'dist/bundle.js',
    'nested/credentials.json', 'nested/secrets.yaml', 'companion/cache.pyc']) {
    const candidate = new Map(files); candidate.set(path, Buffer.from('synthetic'));
    assert.match(validatePublicFiles(candidate, policy).join('\n'), /Excluded publication content/, path);
  }
});

test('new samples need provenance and modified samples or the sole archive exception fail closed', async () => {
  const files = await publicFixture();
  for (const path of ['examples/new-sample.md', policy.archiveExceptions[0].path, 'examples/papers/activation-functions.md']) {
    const candidate = new Map(files); candidate.set(path, Buffer.from('unreviewed replacement'));
    assert.match(validatePublicFiles(candidate, policy).join('\n'), /provenance|checksum/i, path);
  }
  const removed = new Map(files); removed.delete('examples/papers/activation-functions.md');
  assert.match(validatePublicFiles(removed, policy).join('\n'), /Missing protected file/);
});

test('text attestations tolerate CRLF but never content changes and raw archives stay byte exact', async () => {
  const files = await publicFixture();
  const sample = 'examples/papers/activation-functions.md';
  files.set(sample, Buffer.from(files.get(sample).toString('utf8').replaceAll('\r\n', '\n').replaceAll('\n', '\r\n')));
  assert.deepEqual(validatePublicFiles(files, policy), []);
  const archive = policy.archiveExceptions[0].path;
  files.set(archive, Buffer.concat([files.get(archive), Buffer.from('\n')]));
  assert.match(validatePublicFiles(files, policy).join('\n'), /checksum/i);
});

test('hosting, preparation hooks, license copies, baseline and narrow scanner rules cannot drift silently', async () => {
  const files = await publicFixture();
  const cases = [
    [policy.hosting.path, JSON.stringify({...policy.hosting.value, account_id: 'synthetic-account'})],
    ['package.json', JSON.stringify({license: 'MIT', repository: policy.package.repository, scripts: {}})],
    [policy.companionManifest, JSON.stringify({schemaVersion: 1, files: ['LICENSE']})],
    ['companion/LICENSE', 'MIT License\ntruncated'],
    ['companion/THIRD_PARTY_NOTICES.md', 'removed notices'],
    ['tests/fixtures/public-baseline.json', '{}'],
    ['.gitleaks.toml', '[allowlist]\npaths = ["tests/.*"]\n'],
  ];
  for (const [path, content] of cases) {
    const candidate = new Map(files); candidate.set(path, Buffer.from(content));
    assert.notDeepEqual(validatePublicFiles(candidate, policy), [], path);
  }
});

test('operator references are checked in source, config and tests without blanket exclusions', async () => {
  const files = await publicFixture();
  const privateRepo = ['github.com/zthagyamin/', 'zhixue-study-loop'].join('');
  const privatePath = ['C:/Users/', String(30000 + 972), '/private'].join('');
  for (const path of ['src/example.ts', 'tests/synthetic.test.mjs', 'config.json']) {
    for (const content of [privateRepo, privatePath, ['appgprj_', 'synthetic123'].join(''),
      ['-----BEGIN ', 'PRIVATE KEY-----'].join('')]) {
      const candidate = new Map(files); candidate.set(path, Buffer.from(content));
      assert.match(validatePublicFiles(candidate, policy).join('\n'), /Forbidden text/);
    }
  }
});

test('path collisions and path-shaped map keys do not bypass rules', async () => {
  const files = await publicFixture();
  files.set('README.MD', Buffer.from('collision'));
  files.set('../outside.md', Buffer.from('outside'));
  assert.match(validatePublicFiles(files, policy).join('\n'), /collision/i);
  assert.match(validatePublicFiles(files, policy).join('\n'), /path/i);
});

test('known operator references are detected in UTF-16 source as well as UTF-8', async () => {
  const files = await publicFixture();
  files.set('synthetic.txt', Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(['appgprj_', 'synthetic123'].join(''), 'utf16le')]));
  assert.match(validatePublicFiles(files, policy).join('\n'), /Forbidden text/);
});

async function temporaryRepository(t) {
  const root = await mkdtemp(join(tmpdir(), 'zhixue-public-policy-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  execFileSync('git', ['init', '--quiet', root]);
  const files = await publicFixture();
  files.set('public-distribution-policy.json', Buffer.from(JSON.stringify(policy)));
  // Integration fixture contains tiny documents, not a copy of the public repository.
  for (const path of policy.requiredFiles.filter(path => path.endsWith('.md'))) {
    if (!policy.protectedFiles.some(row => row.path === path)) files.set(path, Buffer.from('# Synthetic public document\n'));
  }
  for (const [path, content] of files) {
    await mkdir(dirname(join(root, path)), {recursive: true});
    await writeFile(join(root, path), content);
  }
  // Real documentation links in pinned original samples resolve to the pinned sample corpus.
  execFileSync('git', ['add', '.'], {cwd: root, stdio: 'pipe'});
  return root;
}

test('Git integration inspects tracked and nonignored untracked files, not ignored generated assets', async t => {
  const root = await temporaryRepository(t);
  assert.deepEqual((await inspectPublicRepository(root)).errors, []);
  const success = spawnSync(process.execPath, [join(repo, 'scripts/check-open-source.mjs')], {cwd: root, encoding: 'utf8'});
  assert.equal(success.status, 0, success.stderr);
  assert.equal(JSON.parse(success.stdout).publicBoundary, 'passed');
  await writeFile(join(root, '.gitignore'), 'generated/\n');
  await mkdir(join(root, 'generated'));
  await writeFile(join(root, 'generated/runtime.exe'), 'ignored generated fixture');
  assert.deepEqual((await inspectPublicRepository(root)).errors, []);
  await mkdir(join(root, 'docs/plans'), {recursive: true});
  await writeFile(join(root, 'docs/plans/operator.md'), 'synthetic private handoff');
  assert.match((await inspectPublicRepository(root)).errors.join('\n'), /Excluded publication content/);
  const result = spawnSync(process.execPath, [join(repo, 'scripts/check-open-source.mjs')], {cwd: root, encoding: 'utf8'});
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Excluded publication content/);
});

test('Git index symlink modes fail even when the working copy has been replaced with a regular file', async t => {
  const root = await temporaryRepository(t);
  const oid = execFileSync('git', ['hash-object', '-w', '--stdin'], {cwd: root, input: 'outside-target', encoding: 'utf8'}).trim();
  execFileSync('git', ['update-index', '--add', '--cacheinfo', `120000,${oid},unsafe-link`], {cwd: root});
  await writeFile(join(root, 'unsafe-link'), 'ordinary working-copy file');
  assert.match((await inspectPublicRepository(root)).errors.join('\n'), /Unsupported Git publication mode/);
});

test('Git integration rejects deleted tracked files and broken or escaping Markdown links', async t => {
  const root = await temporaryRepository(t);
  await writeFile(join(root, 'README.md'), '[missing](missing.md)\n[outside](../outside.md)\n');
  const errors = (await inspectPublicRepository(root)).errors.join('\n');
  assert.match(errors, /Broken local documentation link/);
  assert.match(errors, /Unsafe local documentation link/);
  await rm(join(root, 'LICENSE'));
  assert.match((await inspectPublicRepository(root)).errors.join('\n'), /Cannot read publication file: LICENSE/);
});

test('Git integration refuses symlinks and junction parents without reading their target', async t => {
  const root = await temporaryRepository(t);
  const outside = await mkdtemp(join(tmpdir(), 'zhixue-public-outside-'));
  t.after(() => rm(outside, {recursive: true, force: true}));
  await writeFile(join(outside, 'fixture.md'), 'outside content');
  const oid = execFileSync('git', ['hash-object', '-w', '--stdin'], {cwd: root, input: 'synthetic', encoding: 'utf8'}).trim();
  execFileSync('git', ['update-index', '--add', '--cacheinfo', `100644,${oid},linked/fixture.md`], {cwd: root});
  await symlink(outside, join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.match((await inspectPublicRepository(root)).errors.join('\n'), /link/i);
  assert.equal(digest(await readFile(join(outside, 'fixture.md'))), digest('outside content'));
});
