import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {loadTsx} from './fixtures/tsx-components.mjs';

test('AI pending and failure feedback retain the panel position and collapse controls',()=>{
  const {StudyAIPanelFallback}=loadTsx(new URL('../app/components/ai-sidebar/study-ai-entry.tsx',import.meta.url));
  const render=props=>renderToStaticMarkup(createElement(StudyAIPanelFallback,{onClose:()=>{},...props}));
  assert.match(render({mode:'docked'}),/<aside[^>]+class="study-ai-panel"[^>]+data-mode="docked"/);
  assert.match(render({mode:'collapsed'}),/<aside hidden=""/);
  const failure=render({mode:'docked',retry:()=>{}});
  assert.match(failure,/role="alert"/);assert.match(failure,/重新加载/);assert.match(failure,/收起 AI 学习助手/);
});
