import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createPaperWorkshopReview} from '../app/paper-reading/review.ts';
import {buildPaperReview} from '../app/paper-review-budget.ts';
import {DEMO_PAPER_ALEXNET,emptyPaperDraft} from '../app/paper-study.ts';
import {paperTemplate,setPaperTemplate,setPaperSlot} from '../app/paper-slot-templates.ts';
import {parseChatRequest} from '../app/ai/study-ai-chat.ts';
const settings={enabled:true,configured:true,provider:'deepseek',model:'fixture',revision:1};
function source(paper=structuredClone(DEMO_PAPER_ALEXNET),draft=emptyPaperDraft()){
 return {owner:'test-owner',library:'test-library',paper,paragraph:paper.sections[0].paragraphs[0],draft};
}
for(const template of ['empirical','theory','free'])test('workshop '+template+' review reuses budget, active outline and excerpt approval without modifying old draft',async()=>{
 let draft=setPaperTemplate(emptyPaperDraft(),template);for(const field of paperTemplate(template).fields)draft=setPaperSlot(draft,field.key,'长主线'.repeat(999));
 const material=source(undefined,draft),before=structuredClone(material),expected=buildPaperReview('核对',material.paper,material.paragraph,draft),calls=[];
 const service=createPaperWorkshopReview({source:()=>material,settings:()=>settings,requestId:()=> 'controlled-review',ai:{async *chat(request){calls.push(request);yield {type:'delta',text:'Source-bound reference'};}}});
 await service.review('核对');assert.equal(service.snapshot().prompt,expected.prompt);assert.equal(service.snapshot().notice,expected.notice);
 assert.equal(service.snapshot().status,'confirmation-required');assert.equal(calls.length,0);
 await service.confirmExcerpt();assert.doesNotThrow(()=>parseChatRequest(calls[0]));assert.deepEqual(calls[0].context,expected.context);
 assert.deepEqual(material,before);assert.doesNotMatch(JSON.stringify(calls[0]),/test-owner|test-library/);
});
test('workshop review sends no model request for missing or mismatched original source',async()=>{
 for(const rawEn of ['', 'Different material']){
  const material=source();material.paragraph={...material.paragraph,rawEn};let calls=0;
  const service=createPaperWorkshopReview({source:()=>material,settings:()=>settings,requestId:()=> 'controlled-review',ai:{async *chat(){calls++;yield {type:'done'};}}});
  await service.review('核对');assert.equal(calls,0);assert.match(service.snapshot().notice,/缺少可核对的原文/);
 }
});
test('owner, library, paper version, paragraph, template and edited outline cannot reuse excerpt intent',async()=>{
 for(const change of [s=>s.owner='other',s=>s.library='other',s=>s.paper.paperId='other',s=>s.paper.origin={...s.paper.origin,version:'other'},s=>s.paragraph={...s.paragraph,id:'other'},s=>s.draft=setPaperTemplate(s.draft,'theory'),s=>s.draft=setPaperSlot(s.draft,'motivation','changed'),s=>s.isCurrent=()=>false]){
  const material=source();material.draft=setPaperSlot(material.draft,'motivation','长'.repeat(2999));let calls=0;
  const service=createPaperWorkshopReview({source:()=>material,settings:()=>settings,requestId:()=> 'controlled-review',ai:{async *chat(){calls++;yield {type:'done'};}}});
  await service.review('核对');assert.equal(service.snapshot().status,'confirmation-required');change(material);
  await service.confirmExcerpt();assert.equal(calls,0);assert.equal(service.snapshot().status,'idle');
 }
});
test('compatibility plugin submits review intent and exposes copy/stop controls without raw model or random identity calls',()=>{
 const text=readFileSync(new URL('../app/plugins/plugin-paper.tsx',import.meta.url),'utf8');
 assert.doesNotMatch(text,/\.service\.chat\s*\(|crypto\.randomUUID\s*\(|buildPaperReview\s*\(/);
 assert.match(text,/review\.review\(action\)/);assert.match(text,/useSyncExternalStore\(review\.subscribe,review\.snapshot/);
 assert.match(text,/review\.confirmExcerpt\(\)/);assert.match(text,/复制审稿问题/);assert.match(text,/停止回答/);
});
