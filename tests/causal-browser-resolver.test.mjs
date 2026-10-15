import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { win32, posix } from 'node:path';
import vm from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../.github/causal-browser.mjs', import.meta.url), 'utf8');
const literal = source.match(/const doubles=(\{[^\n]+\});\r?\n server=/)?.[1];
assert.ok(literal, 'The test exercises the actual browser fixture plugin');
function plugin(path, root) {
  return vm.runInNewContext(`(${literal})`, {
    root, resolve: path.resolve, replacements: {
      'app/plugins/index.ts': 'synthetic registry', 'app/study-guidance.tsx': 'synthetic guidance',
    },
  });
}

for (const [label, path, root, importer] of [
  ['Windows paths', win32, 'C:\\repo', 'C:\\repo\\app\\practice-session.tsx'],
  ['Windows Vite slash paths', win32, 'C:\\repo', 'C:/repo/app/practice-session.tsx'],
  ['Linux paths', posix, '/repo', '/repo/app/practice-session.tsx'],
]) test(label + ' route nested imports to the explicit fixture adapter', () => {
  const doubles = plugin(path, root);
  assert.equal(doubles.resolveId('./plugins', importer), '\0causal-double:app/plugins/index.ts');
  assert.equal(doubles.load('\0causal-double:app/plugins/index.ts'), 'synthetic registry');
  assert.equal(doubles.resolveId('./unregistered-module', importer), undefined);
});

test('explicit application URLs use only registered fixture adapters', () => {
  const doubles = plugin(win32, 'C:\\repo');
  assert.equal(doubles.resolveId('/app/study-guidance.tsx'), '\0causal-double:app/study-guidance.tsx');
  assert.equal(doubles.resolveId('/app/real-component.tsx'), undefined);
});
