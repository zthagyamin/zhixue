import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement as h} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {loadTsx} from './fixtures/tsx-components.mjs';
const {CompanionSettingsCard}=loadTsx(new URL('../app/companion-settings-card.tsx',import.meta.url));
const base={endpoint:'http://127.0.0.1:43125',signedIn:true,paired:false,connected:true,detected:'online',version:null,message:'',code:'synthetic',refreshing:false,onCode(){},onLaunch(){},onDetect(){},onPair(){},onSync(){}};
test('pairing disables code, pair, detect and launch while exposing its progress',()=>{
  const html=renderToStaticMarkup(h(CompanionSettingsCard,{...base,pairing:true}));
  assert.match(html,/<section[^>]*id="companion-pairing"[^>]*tabindex="-1"/);
  assert.match(html,/<input[^>]*disabled=""/);
  for(const label of ['正在配对…','检测连接','启动已安装 Companion'])assert.match(html,new RegExp('<button[^>]*disabled=""[^>]*>'+label+'</button>'));
  assert.doesNotMatch(html,/href="zhixue-companion:\/\/start"/);
});
test('pairing also disables an existing connection sync action',()=>{
  const html=renderToStaticMarkup(h(CompanionSettingsCard,{...base,paired:true,pairing:true}));
  assert.match(html,/<button[^>]*disabled=""[^>]*>立即同步资料<\/button>/);
});
test('a settled pairing restores editable code and normal actions without changing old callers',()=>{
  for(const pairing of [undefined,false]){
    const html=renderToStaticMarkup(h(CompanionSettingsCard,{...base,pairing}));
    assert.match(html,/<button[^>]*>立即配对<\/button>/);assert.match(html,/href="zhixue-companion:\/\/start"/);
    assert.doesNotMatch(html,/<input[^>]*disabled=""/);assert.doesNotMatch(html,/正在配对…/);
  }
});
