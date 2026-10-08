import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {loadTsx} from './fixtures/tsx-components.mjs';
const {PaperSelectionToolbar}=loadTsx(new URL('../app/components/paper-selection-toolbar.tsx',import.meta.url));
function render(props={}){return renderToStaticMarkup(createElement(PaperSelectionToolbar,{
  word:{id:'p:0:8',term:'gradient',meaning:'梯度',section:'Methods',page:3,start:0,end:8},raw:{current:null},selected:true,busy:false,pending:false,connected:true,focusOnOpen:false,message:'',onMeaning(){},onIngest(){},onRetry(){},onClose(){},onTray(){},...props,
}));}
test('selection controls expose the captured word, editable meaning, speech and explicit write action',()=>{
  const html=render();assert.match(html,/就地收词/);assert.match(html,/朗读 gradient/);assert.match(html,/这句话中的含义/);assert.match(html,/value="梯度"/);assert.match(html,/写入 Obsidian 词库/);assert.match(html,/第 3 页/);
});
test('pending and offline states preserve the editing surface and cannot silently submit a new word',()=>{
  const pending=render({pending:true});assert.match(pending,/重试上次收词/);assert.doesNotMatch(pending,/写入 Obsidian 词库/);
  const offline=render({connected:false});assert.match(offline,/Companion 未连接/);assert.match(offline,/disabled=""/);assert.doesNotMatch(offline,/readOnly=""/);
});
test('a confirmed word is read-only and cannot be resubmitted by the finished toolbar',()=>{
  const html=render({selected:false});assert.match(html,/readOnly=""/);assert.match(html,/已收录/);assert.match(html,/disabled=""/);
});
