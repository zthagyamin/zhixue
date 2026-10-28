import assert from 'node:assert/strict';
import test from 'node:test';
import {loadTsx} from './fixtures/tsx-components.mjs';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

test('a verified automatic draft is identified while an ordinary historical draft stays unknown',()=>{
  const {StudyUnplannedToday}=loadTsx(new URL('../app/study-unplanned-today.tsx',import.meta.url));
  const props={state:{currentPlan:{tasks:[{taskId:'x',category:'review',title:'复习',quantity:1}]},approvedPlan:null},day:'2026-10-28',busy:false,onGenerate(){},onReview(){},onRetry(){}};
  const automatic=renderToStaticMarkup(createElement(StudyUnplannedToday,{...props,draftOrigin:'automatic'}));
  assert.match(automatic,/由长期计划自动准备/);assert.match(automatic,/草稿尚未生效/);
  const unknown=renderToStaticMarkup(createElement(StudyUnplannedToday,props));
  assert.match(unknown,/来源待核对/);assert.doesNotMatch(unknown,/由长期计划自动准备/);
});
