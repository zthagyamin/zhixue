import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement as h} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {loadTsx} from './fixtures/tsx-components.mjs';
const {StudyWorkspaceNavigation}=loadTsx(new URL('../app/study-workspace-navigation.tsx',import.meta.url));
const {LandingContent}=loadTsx(new URL('../app/landing-content.tsx',import.meta.url));
test('workspace has a real homepage link separate from Today',()=>{
 const html=renderToStaticMarkup(h(StudyWorkspaceNavigation,{activeId:'today',subjects:[],onNavigate(){},onSettings(){}}));
 assert.match(html,/<a[^>]*href="\/"[^>]*aria-label="返回首页"/);
 assert.match(html,/>首页<\/a>/);assert.match(html,/aria-label="今日"/);
});
test('landing carries the launching Companion port through sign in and continue',()=>{
 const studyHref='/study?pair=1&companionPort=43125';
 const member=renderToStaticMarkup(h(LandingContent,{signedIn:true,studyHref}));
 assert.match(member,/href="\/study\?pair=1&amp;companionPort=43125"/);
 const guest=renderToStaticMarkup(h(LandingContent,{signedIn:false,studyHref}));
 assert.match(guest,/return_to=%2Fstudy%3Fpair%3D1%26companionPort%3D43125/);
});
test('returning home preserves a non-default Companion port',()=>{
 const html=renderToStaticMarkup(h(StudyWorkspaceNavigation,{homeHref:'/?companionPort=65323',activeId:'today',subjects:[],onNavigate(){},onSettings(){}}));
 assert.match(html,/href="\/\?companionPort=65323"/);
});
