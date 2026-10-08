import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement as h} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {loadTsx} from './fixtures/tsx-components.mjs';
import {normalizeDynamicSubjects} from '../app/dynamic-ui-model.ts';
const ui=loadTsx(new URL('../app/study-session-shell.tsx',import.meta.url));
test('subject disclosure renders arbitrary registered subjects without a discipline whitelist',()=>{
  assert.equal(typeof ui.StudySubjectMenu,'function');
  const subjects=normalizeDynamicSubjects([{id:'botany-fieldwork',name:'植物分类野外记录',sourceMode:'gateway',pluginType:'quiz',items:[{itemId:'leaf-one',prompt:'观察叶序'}]},
    {id:'audio-phonetics',name:'语音学实验',sourceMode:'gateway',pluginType:'recall',items:[{itemId:'sound-one',prompt:'回忆实验'}]}]);
  const html=renderToStaticMarkup(h(ui.StudySubjectMenu,{subjects,activeId:'botany-fieldwork',onChoose(){}}));
  assert.match(html,/植物分类野外记录/);assert.match(html,/语音学实验/);assert.match(html,/aria-current="page"/);
  assert.doesNotMatch(html,/IELTS|Python|论文核心观点/);
});
test('an empty catalog has an honest subject-menu state, not fabricated courses',()=>{
  assert.equal(typeof ui.StudySubjectMenu,'function');
  const html=renderToStaticMarkup(h(ui.StudySubjectMenu,{subjects:[],activeId:'today',onChoose(){}}));
  assert.match(html,/暂无可学习的学科/);assert.doesNotMatch(html,/<button/);
});
test('selecting a subject invokes onChoose with the correct subject id',()=>{
  let selected=null;
  const subjects=[{id:'botany-fieldwork',name:'植物分类野外记录'},{id:'audio-phonetics',name:'语音学实验'}];
  const tree=ui.StudySubjectMenu({subjects,activeId:'botany-fieldwork',onChoose(id){selected=id;}});
  const ul=tree.props.children;
  const items=ul.props.children;
  assert.equal(items.length,2);
  const secondBtn=items[1].props.children;
  assert.equal(typeof secondBtn.props.onClick,'function');
  secondBtn.props.onClick();
  assert.equal(selected,'audio-phonetics');
});
