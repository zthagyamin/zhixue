import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import test from 'node:test';
import {resolvePython, spawnPythonSync} from '../scripts/python-runtime.mjs';

const runner = fileURLToPath(new URL('../scripts/run-python-suite.mjs', import.meta.url));
for (const [name, executable] of [
  ['missing interpreter', fileURLToPath(new URL('./fixtures/python-not-installed.exe', import.meta.url))],
  ['non-Python executable', process.execPath],
]) {
  test(`suite runner explains ${name} without falling back or starting tests`, () => {
    const result = spawnSync(process.execPath, [runner], {
      encoding: 'utf8', windowsHide: true, timeout: 15000,
      env: {...process.env, PYTHON: executable},
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Python 3\.11\+/);
    assert.match(result.stderr, /Set PYTHON to .*executable/);
    assert.doesNotMatch(result.stdout + result.stderr, /Ran \d+ tests|test_.*\.\.\./);
  });
}

const accepted = (executable = '/existing/python3', version = [3, 12]) => ({
  status: 0, stdout: JSON.stringify({executable, version}), stderr: '',
});

test('minimum supported Python 3.11 is accepted', () => {
  assert.equal(resolvePython({env: {PYTHON: 'chosen'}, run: () => accepted('/existing/python3', [3, 11])}), '/existing/python3');
});

test('explicit paths with spaces are one executable argument and never fall back', () => {
  const command = 'C:/existing tools/Python/python.exe';
  const calls = [];
  assert.equal(resolvePython({env: {PYTHON: command}, platform: 'win32', run: (name, args, options) => {
    calls.push(name);
    assert.equal(options.shell, false);
    assert.ok(args.includes('-I'));
    return accepted(command);
  }}), command);
  assert.deepEqual(calls, [command]);
  const failed = [];
  assert.throws(() => resolvePython({env: {PYTHON: command}, run: name => {
    failed.push(name);
    return {error: {code: 'EACCES'}, status: null};
  }}), /EACCES.*Set PYTHON/);
  assert.deepEqual(failed, [command]);
});

test('Windows uses an existing launcher runtime and disables automatic installation', () => {
  const env = {PYLAUNCHER_ALLOW_INSTALL: '1', pylauncher_always_install: '1', PYTHON_MANAGER_AUTOMATIC_INSTALL: 'true', PATH: 'unchanged'};
  const before = {...env};
  const result = resolvePython({env, platform: 'win32', run: (name, args, options) => {
    assert.equal(name, 'py');
    assert.equal(args[0], '-3');
    assert.equal(options.env.PYTHON_MANAGER_AUTOMATIC_INSTALL, 'false');
    assert.equal(options.env.PYLAUNCHER_ALLOW_INSTALL, undefined);
    assert.equal(options.env.pylauncher_always_install, undefined);
    assert.equal(options.env.PATH, env.PATH);
    return accepted('C:/existing/python.exe');
  }});
  assert.equal(result, 'C:/existing/python.exe');
  assert.deepEqual(env, before);
});

test('Windows falls back from an absent launcher and Store placeholder to existing python3', () => {
  const commands = [];
  assert.equal(resolvePython({env: {}, platform: 'win32', run: name => {
    commands.push(name);
    return name === 'py' ? {error: {code: 'ENOENT'}} : name === 'python' ? {status: 9009} : accepted();
  }}), '/existing/python3');
  assert.deepEqual(commands, ['py', 'python', 'python3']);
});

test('Unix selects python3 first, with an existing python fallback for incompatible versions', () => {
  const commands = [];
  assert.equal(resolvePython({env: {}, platform: 'linux', run: name => {
    commands.push(name);
    return name === 'python3' ? accepted('/old/python3', [3, 10]) : accepted();
  }}), '/existing/python3');
  assert.deepEqual(commands, ['python3', 'python']);
});

for (const [name, reply] of [
  ['Python 2', accepted('/old/python', [2, 7])],
  ['Python 3.10', accepted('/old/python', [3, 10])],
  ['malformed version', accepted('/bad/python', [3, '12'])],
  ['empty executable', accepted('')],
  ['non-JSON output', {status: 0, stdout: 'not Python'}],
  ['probe timeout', {status: null, error: {code: 'ETIMEDOUT'}}],
]) {
  test(`rejects ${name} with instructions and no silent explicit override`, () => {
    let count = 0;
    assert.throws(() => resolvePython({env: {PYTHON: 'chosen'}, run: () => {count++; return reply;}}), error => {
      assert.equal(error.code, 'PYTHON_RUNTIME_UNAVAILABLE');
      assert.match(error.message, /Python 3\.11\+.*Set PYTHON/);
      return true;
    });
    assert.equal(count, 1);
  });
}

test('when no runtime exists, the bounded candidate list gives actionable diagnostics', () => {
  const commands = [];
  assert.throws(() => resolvePython({env: {}, platform: 'linux', run: (name, _args, options) => {
    commands.push(name);
    assert.equal(options.timeout, 5000);
    return {error: {code: 'ENOENT'}};
  }}), /python3: ENOENT; python: ENOENT.*No runtime was installed/);
  assert.deepEqual(commands, ['python3', 'python']);
});

test('selected real runtime preserves Unicode input, caller environment and child failure status', () => {
  const result = spawnPythonSync(['-X', 'utf8', '-B', '-c', 'import os,sys; print(sys.stdin.read()+os.environ["ZHIXUE_TEST_VALUE"]); sys.exit(7)'], {
    input: '中文 ', encoding: 'utf8', timeout: 10000, env: {...process.env, ZHIXUE_TEST_VALUE: 'fixture'},
  });
  assert.ifError(result.error);
  assert.equal(result.status, 7);
  assert.equal(result.stdout.trim(), '中文 fixture');
});
