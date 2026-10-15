import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {loadTsx} from './fixtures/tsx-components.mjs';
import {createPaperReadingUnit} from '../src/domain/paper-reading/unit.ts';
const {PaperReadingPage}=loadTsx(new URL('../src/features/paper-reading/page.tsx',import.meta.url));
test('focused reading exposes source, complete selected content and optional tools without workshop defaults',()=>{
 const paper={paperId:'source',title:'Readable paper',sections:[{id:'s',title:'Methods',paragraphs:[{id:'p',rawEn:'Complete original paragraph.',pageNumber:5}]}]};
 const markup=renderToStaticMarkup(createElement(PaperReadingPage,{title:paper.title,unit:createPaperReadingUnit(paper,0,1),saving:false,
  onPosition:()=>{},onCount:()=>{},onOriginal:()=>{},sourceAvailable:true,
  renderText:text=>createElement('p',null,text),tools:createElement('p',null,'Optional old tools')}));
 assert.match(markup,/论文专注阅读/);assert.match(markup,/Readable paper/);assert.match(markup,/Methods/);
 assert.match(markup,/PDF 第 5 页/);assert.match(markup,/Complete original paragraph\./);assert.match(markup,/查看原页/);
 assert.match(markup,/<details[^>]*><summary>更多工具<\/summary>/);assert.doesNotMatch(markup,/会末 5 分钟重构|开读 1 分钟检索/);
});
test('failed saving preserves all text and blocks unit advancement; original-page limitation is honest',()=>{
 const unit=createPaperReadingUnit({paperId:'s',title:'Source',sections:[{id:'s',title:'Text',paragraphs:[{id:'p',rawEn:'Still here.'},{id:'p2',rawEn:'Next.'}]}]},0,1);
 const markup=renderToStaticMarkup(createElement(PaperReadingPage,{title:'Source',unit,saving:false,error:'保存失败，输入已保留。',
  sourceAvailable:false,onPosition:()=>{},onCount:()=>{},renderText:text=>createElement('p',null,text)}));
 assert.match(markup,/Still here\./);assert.match(markup,/role="alert"/);assert.match(markup,/原页暂不可用/);
 assert.match(markup,/<button[^>]*disabled=""[^>]*>下一段/);
});
test('return navigation retains the supplied validated Companion endpoint',()=>{
 const unit=createPaperReadingUnit({paperId:'s',title:'Source',sections:[{id:'s',title:'Text',paragraphs:[{id:'p',rawEn:'Original.'}]}]},0,1);
 const markup=renderToStaticMarkup(createElement(PaperReadingPage,{title:'Source',unit,saving:false,returnHref:'/study?companionPort=43210',sourceAvailable:false,onPosition:()=>{},onCount:()=>{},renderText:text=>text}));
 assert.match(markup,/href="\/study\?companionPort=43210"/);
});
