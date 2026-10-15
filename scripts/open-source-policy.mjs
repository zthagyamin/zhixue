import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {lstat, readFile} from 'node:fs/promises';
import {dirname, relative, resolve, sep} from 'node:path';

const ARCHIVE = 'public/knowledge-starter-kit/structure.zip';
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const beneath = (path, directory) => path === directory || path.startsWith(`${directory}/`);

// Reject traversal instead of resolving it away, including ambiguous Windows names.
export function normalizePublicPath(value) {
  if (typeof value !== 'string' || !value) throw Error('Invalid publication path');
  if ([...value].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    || /[:*?"<>|]/.test(value)) throw Error('Invalid publication path');
  const path = value.replaceAll('\\', '/');
  if (path.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part)
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw Error('Unsafe publication path');
  return path;
}

export function validatePolicy(policy) {
  const errors = [];
  const check = (condition, message) => { if (!condition) errors.push(`Invalid public policy: ${message}`); };
  if (!isObject(policy)) return ['Invalid public policy: expected object'];
  check(policy.schemaVersion === 1, 'unsupported schemaVersion');
  check(typeof policy.policyVersion === 'string' && /^\d+\.\d+\.\d+$/.test(policy.policyVersion), 'policyVersion required');
  check(policy.review?.manualReviewRequired === true && /^[a-f0-9]{40}$/.test(policy.review?.baselineCommit ?? '')
    && text(policy.review?.scope), 'manual review and public baseline provenance required');
  const paths = (values, label) => {
    if (!Array.isArray(values) || !values.length) { check(false, `${label} must be nonempty`); return; }
    const seen = new Set();
    for (const value of values) {
      try {
        const normalized = normalizePublicPath(value);
        check(value === normalized, `${label} must use canonical paths`);
        check(!seen.has(normalized.toLowerCase()), `duplicate ${label}: ${value}`);
        seen.add(normalized.toLowerCase());
      } catch { check(false, `${label} contains an unsafe path`); }
    }
  };
  paths(policy.requiredFiles, 'requiredFiles');
  paths(policy.provenanceRoots, 'provenanceRoots');
  paths(policy.excluded?.directories, 'excluded directories');
  paths(policy.excluded?.directoryNames, 'excluded directoryNames');
  check(Array.isArray(policy.excluded?.extensions) && policy.excluded.extensions.length > 0
    && policy.excluded.extensions.every(value => /^\.[a-z0-9.-]+$/.test(value)), 'excluded extensions required');
  const patterns = (values, label) => {
    if (!Array.isArray(values) || !values.length) { check(false, `${label} required`); return; }
    for (const value of values) {
      try { if (!text(value)) throw Error(); new RegExp(value, 'i'); }
      catch { check(false, `${label} contains invalid regex`); }
    }
  };
  patterns(policy.excluded?.filenamePatterns, 'filenamePatterns');
  patterns(Array.isArray(policy.contentPatterns) ? policy.contentPatterns.map(row => row?.pattern) : [], 'contentPatterns');
  check(Array.isArray(policy.contentPatterns) && policy.contentPatterns.every(row => text(row?.id)), 'content pattern ids required');
  const pins = policy.protectedFiles;
  paths(Array.isArray(pins) ? pins.map(row => row?.path) : [], 'protectedFiles');
  if (Array.isArray(pins)) {
    for (const row of pins) check(/^[a-f0-9]{64}$/.test(row?.sha256 ?? '')
      && ['bytes', 'utf8-lf'].includes(row?.normalization) && text(row?.provenance), 'each protected file requires checksum, normalization and provenance');
    for (const path of ['LICENSE', 'companion/LICENSE', 'THIRD_PARTY_NOTICES.md', 'companion/THIRD_PARTY_NOTICES.md', '.gitleaks.toml', 'companion/config.json',
      'tests/fixtures/public-baseline.json', 'tests/fixtures/nonword-baseline-preview.mjs']) {
      check(pins.some(row => row?.path === path), `missing invariant attestation: ${path}`);
    }
  }
  check(Array.isArray(policy.archiveExceptions) && policy.archiveExceptions.length === 1
    && policy.archiveExceptions[0]?.path === ARCHIVE && text(policy.archiveExceptions[0]?.reason), 'only the exact starter-kit archive exception is supported');
  check(Array.isArray(pins) && pins.some(row => row?.path === ARCHIVE && row.normalization === 'bytes'), 'archive exception needs a byte checksum');
  check(policy.hosting?.path === '.openai/hosting.json' && isObject(policy.hosting?.value)
    && policy.hosting.value.project_id === null && policy.hosting.value.d1 === 'DB' && policy.hosting.value.r2 === null
    && Object.keys(policy.hosting.value).length === 3, 'neutral hosting template required');
  check(policy.package?.license === 'MIT' && policy.package?.repository === 'https://github.com/zthagyamin/zhixue'
    && isObject(policy.package?.scripts) && ['predev', 'prebuild', 'pretest', 'assets:companion'].every(key => text(policy.package.scripts[key])), 'public package and asset hooks required');
  check(policy.companionManifest === 'companion/program-files.json', 'single Companion program manifest required');
  return errors;
}

function checksum(bytes, normalization) {
  const input = normalization === 'utf8-lf' ? bytes.toString('utf8').replaceAll('\r\n', '\n') : bytes;
  return createHash('sha256').update(input).digest('hex');
}

function decodeText(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le');
  if (bytes[0] === 0xfe && bytes[1] === 0xff && bytes.length % 2 === 0) return Buffer.from(bytes.subarray(2)).swap16().toString('utf16le');
  return bytes.toString('utf8');
}

// Pure checks accept synthetic corpora without Git, disk, network or model access.
export function validatePublicFiles(input, policy) {
  const errors = validatePolicy(policy);
  if (errors.length) return errors;
  const files = new Map(), seen = new Set();
  for (const [rawPath, bytes] of input) {
    try {
      const path = normalizePublicPath(rawPath);
      if (seen.has(path.toLowerCase())) errors.push(`Publication path collision: ${path}`);
      seen.add(path.toLowerCase());
      files.set(path, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes));
    } catch { errors.push(`Invalid publication path: ${JSON.stringify(rawPath)}`); }
  }
  for (const path of policy.requiredFiles) if (!files.has(path)) errors.push(`Missing required publication file: ${path}`);
  const pins = new Map(policy.protectedFiles.map(row => [row.path, row]));
  const archives = new Set(policy.archiveExceptions.map(row => row.path));
  const names = policy.excluded.filenamePatterns.map(pattern => new RegExp(pattern, 'i'));
  const contentPatterns = policy.contentPatterns.map(row => ({...row, regex: new RegExp(row.pattern, 'i')}));
  for (const [path, bytes] of files) {
    const lower = path.toLowerCase(), segments = lower.split('/'), basename = segments.at(-1);
    const forbiddenDirectory = policy.excluded.directories.some(directory => beneath(lower, directory.toLowerCase()))
      || segments.slice(0, -1).some(part => policy.excluded.directoryNames.some(name => name.toLowerCase() === part));
    const forbiddenName = names.some(regex => regex.test(basename)) && basename !== '.env.example';
    const forbiddenExtension = policy.excluded.extensions.some(extension => lower.endsWith(extension));
    if (forbiddenDirectory || forbiddenName || (forbiddenExtension && !archives.has(path))) errors.push(`Excluded publication content: ${path}`);
    if (policy.provenanceRoots.some(directory => beneath(lower, directory.toLowerCase())) && !pins.has(path)) errors.push(`Missing reviewed provenance: ${path}`);
    // The only binary exception is pinned byte-for-byte below, never by folder.
    if (!archives.has(path)) {
      const source = decodeText(bytes);
      for (const row of contentPatterns) if (row.regex.test(source)) errors.push(`Forbidden text (${row.id}): ${path}`);
    }
  }
  for (const row of policy.protectedFiles) {
    if (!files.has(row.path)) errors.push(`Missing protected file: ${row.path}`);
    else if (checksum(files.get(row.path), row.normalization) !== row.sha256) errors.push(`Protected checksum differs; review provenance before updating policy: ${row.path}`);
  }
  const json = path => {
    try { return JSON.parse(files.get(path)?.toString('utf8')); }
    catch { errors.push(`Invalid or missing JSON publication file: ${path}`); return null; }
  };
  const hosting = json(policy.hosting.path);
  if (!isObject(hosting) || Object.keys(hosting).length !== Object.keys(policy.hosting.value).length
    || Object.entries(policy.hosting.value).some(([key, value]) => hosting[key] !== value)) errors.push('Hosting template must remain neutral with exactly the reviewed fields');
  const pkg = json('package.json');
  if (pkg?.license !== policy.package.license || pkg?.repository !== policy.package.repository) errors.push('Public package metadata differs');
  for (const [key, command] of Object.entries(policy.package.scripts)) if (pkg?.scripts?.[key] !== command) errors.push(`Public preparation hook differs: ${key}`);
  const manifest = json(policy.companionManifest);
  if (manifest?.schemaVersion !== 1 || !Array.isArray(manifest?.files)) errors.push('Invalid Companion program manifest');
  else for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    if (manifest.files.filter(path => path === name).length !== 1) errors.push(`Companion program manifest must include exactly one ${name}`);
  }
  const license = files.get('LICENSE')?.toString('utf8').replaceAll('\r\n', '\n');
  if (!license?.includes('MIT License') || !license.includes('Permission is hereby granted') || !license.includes('THE SOFTWARE IS PROVIDED "AS IS"')
    || /\[year\]|<year>|\[fullname\]|<copyright holders>/.test(license)) errors.push('Incomplete MIT license');
  if (files.get('companion/LICENSE')?.toString('utf8').replaceAll('\r\n', '\n') !== license) errors.push('Companion LICENSE must preserve the root MIT license');
  for (const path of ['THIRD_PARTY_NOTICES.md', 'companion/THIRD_PARTY_NOTICES.md']) {
    if (!files.get(path)?.toString('utf8').trim()) errors.push(`Missing third-party notices: ${path}`);
  }
  return errors;
}

async function safeFile(root, path) {
  const normalized = normalizePublicPath(path), target = resolve(root, normalized);
  let current = root;
  for (const part of normalized.split('/')) {
    current = resolve(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink()) throw Error('symbolic link or junction is not a publication file');
    if (current !== target && !info.isDirectory()) throw Error('non-directory publication parent');
    if (current === target && !info.isFile()) throw Error('not a regular publication file (submodules are unsupported)');
  }
  return current;
}

async function checkLinks(root, files) {
  const errors = [];
  let linkCount = 0;
  for (const [path, bytes] of files) {
    if (!path.toLowerCase().endsWith('.md')) continue;
    for (const match of decodeText(bytes).matchAll(/!?\[[^\]\n]*\]\(([^)\n]+)\)/g)) {
      let target = match[1].trim().split(/\s+["']/)[0].replace(/^<|>$/g, '').split('#')[0];
      if (!target || /^(?:https?:|mailto:|data:|obsidian:)/i.test(target)) continue;
      linkCount++;
      try {
        target = decodeURIComponent(target);
        if (/^(?:[a-z]+:|\/|\\)/i.test(target)) throw Error('unsafe');
        const destination = relative(root, resolve(root, dirname(path), target.replaceAll('\\', '/'))).split(sep).join('/');
        try { normalizePublicPath(destination); } catch { throw Error('unsafe'); }
        // Generated local assets cannot satisfy a missing public documentation link.
        const representative = files.has(destination) ? destination : [...files.keys()].find(file => file.startsWith(`${destination}/`));
        if (!representative) throw Error('missing');
        await safeFile(root, representative);
      } catch (error) {
        errors.push(`${error.message === 'unsafe' ? 'Unsafe' : 'Broken'} local documentation link: ${path} -> ${target}`);
      }
    }
  }
  return {errors, linkCount};
}

export async function inspectPublicRepository(root) {
  root = resolve(root);
  if ((await lstat(root)).isSymbolicLink()) throw Error('Publication root cannot be a symbolic link');
  const git = args => execFileSync('git', args, {cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024});
  if (resolve(git(['rev-parse', '--show-toplevel']).trim()).toLowerCase() !== root.toLowerCase()) throw Error('Run public checks at the Git repository root');
  const entries = git(['ls-files', '--stage', '-z']).split('\0').filter(Boolean).map(entry => {
    const match = /^(\d+) [a-f0-9]+ (\d)\t([\s\S]+)$/.exec(entry);
    if (!match) throw Error('Invalid Git index entry');
    return {mode: match[1], stage: match[2], path: match[3]};
  });
  const tracked = [...new Set(entries.map(entry => entry.path))];
  if (!tracked.length) throw Error('No tracked public source files to inspect');
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  const errors = [], files = new Map();
  for (const entry of entries) {
    if (!['100644', '100755'].includes(entry.mode) || entry.stage !== '0') errors.push(`Unsupported Git publication mode or unresolved merge: ${entry.path}`);
  }
  for (const path of new Set([...tracked, ...untracked])) {
    try { files.set(path, await readFile(await safeFile(root, path))); }
    catch (error) { errors.push(`Cannot read publication file: ${path} (${error.message})`); }
  }
  let policy;
  try { policy = JSON.parse(files.get('public-distribution-policy.json')?.toString('utf8')); }
  catch { return {errors: [...errors, 'Missing or invalid public-distribution-policy.json']}; }
  errors.push(...validatePublicFiles(files, policy));
  const links = await checkLinks(root, files);
  errors.push(...links.errors);
  return {errors, trackedFiles: tracked.length, untrackedFiles: untracked.length, localLinks: links.linkCount,
    policyVersion: policy.policyVersion, protectedFiles: policy.protectedFiles?.length ?? 0};
}
