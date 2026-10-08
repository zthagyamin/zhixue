import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createElement as h} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {loadTsx} from './fixtures/tsx-components.mjs';
const {StudyAITrigger,StudyAISidebar}=loadTsx(new URL('../app/components/ai-sidebar/study-ai-sidebar.tsx',import.meta.url));
const {StudyAIWorkspace}=loadTsx(new URL('../app/components/ai-sidebar/study-ai-workspace.tsx',import.meta.url));
test('AI entry remains visible before a learning library has loaded',()=>{
  const html=renderToStaticMarkup(h(StudyAITrigger,{onUnavailable(){}}));assert.match(html,/配置 AI 学习助手/);assert.match(html,/配置 AI/);
});
test('a ready workspace starts collapsed without a duplicate floating control',()=>{
  const html=renderToStaticMarkup(h(StudyAIWorkspace,{scope:{mode:'account',ownerId:'owner-a',libraryId:'library-a'},service:{}},h(StudyAISidebar)));
  assert.match(html,/data-mode="collapsed"/);assert.doesNotMatch(html,/class="study-ai-pill"/);assert.match(html,/<aside hidden=""/);
});
