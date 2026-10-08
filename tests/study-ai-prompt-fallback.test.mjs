import test from 'node:test';
import assert from 'node:assert/strict';
const m=await import('../app/ai/study-ai-prompt-fallback.ts').catch(()=>({}));
test('copy prompt includes bounded visible work and excludes arbitrary private fields',()=>{
 assert.equal(typeof m.buildStudyAICopyPrompt,'function');
 const p=m.buildStudyAICopyPrompt({id:'x',title:'Python',question:'why?',code:'print(1)',learnerAnswer:'my attempt',errors:['oops'],apiKey:'SECRET',answer:'HIDDEN'});
 assert.match(p,/why\?/);assert.match(p,/print\(1\)/);assert.match(p,/my attempt/);
 assert.ok(!p.includes('SECRET')&&!p.includes('HIDDEN'));
 assert.ok(m.buildStudyAICopyPrompt({id:'x',title:'t',question:'x'.repeat(10000)}).length<6000);
});
test('disabling page reference removes task data from the copied prompt',()=>{
 const p=m.buildStudyAICopyPrompt({id:'x',title:'PRIVATE',question:'PRIVATE',code:'PRIVATE'},false);
 assert.ok(!p.includes('PRIVATE'));assert.match(p,/问题/);
});
