import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createSourceCompiler} from './helpers/source-compiler.mjs';
import {loader} from './helpers/causal-harness.mjs';

function withSource(run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'zhixue-source-cache-'));
  const file = path.join(directory, 'source.ts');
  try { return run(file); }
  finally { if (fs.existsSync(file)) fs.unlinkSync(file); fs.rmdirSync(directory); }
}

test('unchanged current bytes reuse compilation across reads', () => withSource(file => {
  let compilations = 0;
  const compile = createSourceCompiler(source => { compilations++; return source; });
  fs.writeFileSync(file, 'export const value = 1;');
  assert.equal(compile(file), 'export const value = 1;');
  assert.equal(compile(file), 'export const value = 1;');
  assert.equal(compilations, 1);
}));

test('same-size source edits with unchanged timestamps never reuse old code', () => withSource(file => {
  let compilations = 0;
  const compile = createSourceCompiler(source => { compilations++; return source; });
  fs.writeFileSync(file, 'export const value = 1;');
  const stat = fs.statSync(file);
  assert.equal(compile(file), 'export const value = 1;');
  fs.writeFileSync(file, 'export const value = 2;');
  fs.utimesSync(file, stat.atime, stat.mtime);
  assert.equal(compile(file), 'export const value = 2;');
  assert.equal(compilations, 2);
  fs.unlinkSync(file);
  assert.throws(() => compile(file), /ENOENT/);
}));

test('failed compilation is not a reusable successful entry', () => withSource(file => {
  let attempts = 0;
  const compile = createSourceCompiler(source => {
    if (++attempts === 1) throw Error('compiler interrupted');
    return source;
  });
  fs.writeFileSync(file, 'export const value = 1;');
  assert.throws(() => compile(file), /compiler interrupted/);
  assert.equal(compile(file), 'export const value = 1;');
  assert.equal(attempts, 2);
}));

test('loaders still execute separate module state and resolve their own doubles', () => {
  fs.mkdirSync(new URL('../scratch/', import.meta.url), {recursive: true});
  const directory = fs.mkdtempSync(new URL('../scratch/causal-cache-', import.meta.url));
  const file = path.join(directory, 'fixture.ts');
  const id = path.relative(fileURLToPath(new URL('../', import.meta.url)), file).replaceAll('\\', '/');
  try {
    fs.writeFileSync(file, 'import { tag } from "test-dependency"; let count = 0; export const next = () => ++count; export const label = () => tag;');
    const a = loader({}, {'test-dependency': {tag: 'A'}})(id);
    const b = loader({}, {'test-dependency': {tag: 'B'}})(id);
    assert.equal(a.next(), 1);
    assert.equal(a.next(), 2);
    assert.equal(b.next(), 1);
    assert.equal(a.label(), 'A');
    assert.equal(b.label(), 'B');
    const stat = fs.statSync(file);
    fs.writeFileSync(file, 'import { tag } from "test-dependency"; let count = 9; export const next = () => ++count; export const label = () => tag;');
    fs.utimesSync(file, stat.atime, stat.mtime);
    const updated = loader({}, {'test-dependency': {tag: 'C'}})(id);
    assert.equal(updated.next(), 10);
    assert.equal(updated.label(), 'C');
    assert.equal(a.next(), 3, 'already executed module state is not replaced');
  } finally { fs.unlinkSync(file); fs.rmdirSync(directory); }
});
