import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {seedFixtureStorage} from '../.github/browser-storage-fixture.mjs';
const origin = 'http://127.0.0.1:4173';
const script = `(${seedFixtureStorage.toString()})(config)`;
function sandbox(documentOrigin = origin) {
  const local = new Map(), session = new Map();
  const context = {
    location: {origin: documentOrigin},
    config: {origin, values: {saved: 'fixture-value'}, denyStorage: false},
    localStorage: {setItem: (key, value) => local.set(key, value)},
    sessionStorage: {setItem: (key, value) => session.set(key, value)},
    DOMException,
  };
  context.window = {location: context.location, localStorage: context.localStorage, sessionStorage: context.sessionStorage};
  return {context, local, session};
}
test('storage fixture does not access opaque about:blank or foreign origins', () => {
  for (const documentOrigin of ['null', 'https://foreign.example.invalid']) {
    const {context} = sandbox(documentOrigin);
    for (const key of ['localStorage', 'sessionStorage']) {
      Object.defineProperty(context.window, key, {get() { throw new Error('Storage must not be accessed'); }});
    }
    assert.doesNotThrow(() => runInNewContext(script, context));
  }
});
test('storage fixture seeds local records and login handoff only at the fixture origin', () => {
  const {context, local, session} = sandbox();
  context.config.values['zhixue:onboarding:login:v1'] = '{"status":"completed"}';
  runInNewContext(script, context);
  assert.equal(local.get('saved'), 'fixture-value');
  assert.equal(local.has('zhixue:onboarding:login:v1'), false);
  const record = JSON.parse(session.get('zhixue:onboarding:login:v1'));
  assert.deepEqual(record.progress, {status: 'completed'});
  assert.equal(Number.isFinite(record.at), true);
});
test('storage-denied scenario still throws SecurityError on the fixture document', () => {
  const {context, local} = sandbox();
  context.config.denyStorage = true;
  runInNewContext(script, context);
  assert.equal(local.size, 0);
  assert.throws(() => runInNewContext('window.localStorage', context), {name: 'SecurityError'});
});
test('unexpected storage failure at the correct origin is not swallowed', () => {
  const {context} = sandbox();
  Object.defineProperty(context.window, 'localStorage', {get() { throw new Error('real fixture failure'); }});
  assert.throws(() => runInNewContext(script, context), /real fixture failure/);
});
