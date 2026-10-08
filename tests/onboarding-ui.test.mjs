import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement as h} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {loadTsx} from './fixtures/tsx-components.mjs';
const {OnboardingDialog,OnboardingLesson}=loadTsx(new URL('../app/onboarding.tsx',import.meta.url));
test('the public introduction covers knowledge bases, both paths, Obsidian, Notion, AI and actual practice',()=>{
  const pages=Array.from({length:7},(_,step)=>renderToStaticMarkup(h(OnboardingLesson,{step,path:null,onPath(){}}))).join('');
  for(const text of ['知识库','我已有知识库','我还没有知识库','Obsidian','Notion','API Key','自己尝试'])assert.match(pages,new RegExp(text));
});
test('the first tutorial can be skipped and never requires login just to read',()=>{
  const html=renderToStaticMarkup(h(OnboardingDialog,{progress:{version:1,step:0,path:null,status:'active'},signedIn:false,storageError:false,onSkip(){},onChange(){},onFinish(){},onSignIn(){}}));
  assert.match(html,/跳过新手教学/);assert.match(html,/下一步/);assert.match(html,/现在登录，接着看教学/);assert.doesNotMatch(html,/type="password"/);
});
test('completion is a tutorial state, not a learning score',()=>{
  const html=renderToStaticMarkup(h(OnboardingDialog,{progress:{version:1,step:6,path:'new',status:'active'},signedIn:true,storageError:false,onSkip(){},onChange(){},onFinish(){},onSignIn(){}}));
  assert.match(html,/还没有产生任何练习成绩/);assert.match(html,/用自己的笔记试三题/);assert.ok(html.includes('href="/study#note-trial"'));assert.match(html,/完成教学/);
});
