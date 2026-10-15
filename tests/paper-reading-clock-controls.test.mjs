import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {loadTsx} from './fixtures/tsx-components.mjs';
const {PaperReadingClockControls, PaperReadingClockDetails} = loadTsx(new URL('../src/features/paper-reading-clock/controls.tsx', import.meta.url));
const state = {status: 'ready', elapsedMs: 123000, paused: false, counting: true, saveStatus: 'saved', error: '', softTarget: 'below', sync: 'device-only'};
const markup = (value, extra = {}) => renderToStaticMarkup(createElement(PaperReadingClockControls, {state: value, onPause() {}, ...extra}));
test('reading clock keeps target and elapsed optional and provides pause or continuation', () => {
    assert.match(markup(state), /暂停阅读/); assert.doesNotMatch(markup(state), /软目标|10—15|有效用时/);
    assert.match(markup({...state, paused: true}), /继续阅读/);
    assert.match(markup(state, {showElapsed: true}), /本材料累计有效用时 2 分 3 秒/);
    assert.doesNotMatch(markup({...state, saveStatus: 'saving'}), /disabled=""/);
});
test('clock persistence errors are explicit without claiming that answers were lost or saved', () => {
    const failed = markup({...state, saveStatus: 'failed'}, {onRetry() {}});
    assert.match(failed, /role="alert"/); assert.match(failed, /计时尚未保存/); assert.match(failed, /原答案不受影响/);
    assert.match(failed, /重试保存计时/); assert.doesNotMatch(failed, /已同步|答案已保存/);
    const unavailable = markup({...state, status: 'unavailable'}, {onRetry() {}});
    assert.match(unavailable, /旧计时保留/); assert.match(unavailable, /disabled=""/);
});
test('optional clock details explain soft target and truthful cross-device and quality limits', () => {
    const details = renderToStaticMarkup(createElement(PaperReadingClockDetails, {state: {...state, softTarget: 'beyond'}}));
    assert.match(details, /10—15 分钟是软目标/); assert.match(details, /可按需要继续或暂停/);
    assert.match(details, /尚未同步到其他设备/); assert.match(details, /计时不代表理解或掌握/);
});

test('group controls display actual group time separately from retained material total and hide new-group action in tools', () => {
    const grouped = {...state, groupId: 'current', groupCompleted: false, completedGroupCount: 1, materialElapsedMs: 900000};
    assert.match(markup(grouped, {showElapsed: true}), /本组有效用时 2 分 3 秒/);
    assert.doesNotMatch(markup(grouped), /开始新组|本材料累计/);
    const details = renderToStaticMarkup(createElement(PaperReadingClockDetails, {state: grouped, onStartGroup() {}}));
    assert.match(details, /本组有效用时 2 分 3 秒/); assert.match(details, /本材料累计有效用时 15 分 0 秒/);
    assert.match(details, /开始新组/); assert.match(details, /上一组和材料累计记录保留/);
    assert.match(details, /达到软目标不会自动结束本组/);
    const completed = markup({...grouped, paused: true, groupCompleted: true});
    assert.match(completed, /本组已结束/); assert.match(completed, /disabled=""/);
});
