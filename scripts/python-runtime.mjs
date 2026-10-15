import {spawnSync} from 'node:child_process';

const probe = 'import json,sys; print(json.dumps({"executable":sys.executable,"version":list(sys.version_info[:2])}))';

function existingRuntimeEnvironment(env) {
  const result = {...env};
  for (const key of Object.keys(result)) {
    if (['PYLAUNCHER_ALLOW_INSTALL', 'PYLAUNCHER_ALWAYS_INSTALL', 'PYTHON_MANAGER_AUTOMATIC_INSTALL'].includes(key.toUpperCase())) delete result[key];
  }
  // Both the legacy launcher and current install manager must use existing runtimes only.
  result.PYTHON_MANAGER_AUTOMATIC_INSTALL = 'false';
  return result;
}

export function resolvePython({env = process.env, platform = process.platform, run = spawnSync} = {}) {
  const explicit = env.PYTHON?.trim();
  const candidates = explicit
    ? [[explicit, []]]
    : platform === 'win32'
      ? [['py', ['-3']], ['python', []], ['python3', []]]
      : [['python3', []], ['python', []]];
  const failures = [];
  for (const [command, prefix] of candidates) {
    const result = run(command, [...prefix, '-I', '-B', '-S', '-X', 'utf8', '-c', probe], {
      env: existingRuntimeEnvironment(env), encoding: 'utf8', windowsHide: true,
      timeout: 5000, maxBuffer: 65536, shell: false,
    });
    if (result.error || result.status !== 0) {
      failures.push(`${command}: ${result.error?.code || `exit ${result.status ?? result.signal ?? 'unknown'}`}`);
      continue;
    }
    try {
      const {executable, version} = JSON.parse(result.stdout);
      if (typeof executable === 'string' && executable && Array.isArray(version)
          && version[0] === 3 && Number.isInteger(version[1]) && version[1] >= 11) return executable;
      failures.push(`${command}: requires Python 3.11+`);
    } catch {
      failures.push(`${command}: invalid interpreter response`);
    }
  }
  const error = new Error(`No usable Python 3.11+ runtime. ${failures.join('; ')}. Set PYTHON to an existing Python executable (one path, without command arguments). No runtime was installed.`);
  error.code = 'PYTHON_RUNTIME_UNAVAILABLE';
  throw error;
}

export function spawnPythonSync(args, options = {}) {
  const env = existingRuntimeEnvironment(options.env ?? process.env);
  let executable;
  try {
    executable = resolvePython({env});
  } catch (error) {
    return {error, status: null, signal: null, stdout: '', stderr: ''};
  }
  return spawnSync(executable, args, {...options, env, windowsHide: true, shell: false});
}
