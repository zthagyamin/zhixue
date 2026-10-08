import test from 'node:test';
import assert from 'node:assert/strict';
import {createHooks,loader,nodes,text,tick} from './helpers/causal-harness.mjs';
const identity={attemptId:'recover-code',revision:1,sourceVersion:'a'.repeat(64),testVersion:'a'.repeat(64)};
const passed={schemaVersion:1,runId:2,identity,status:'passed',phase:'tests',outcome:'success',assertionsPassed:1,assertionsExecuted:1,mapping:{prefixLineCount:0,originalLineCount:2}};
const unknown={...passed,runId:1,status:'failed',phase:'program',outcome:'unknown',assertionsPassed:0,assertionsExecuted:0};
async function mount({first,latest,state}){
  const hooks=createHooks();
  const load=loader(hooks.api,{'app/hooks/use-pyodide.ts':{usePyodide:()=>({isReady:true,error:null,runPython(){throw Error('restore must not execute code');},retry(){},cancel(){}})},
    'app/ai/use-report-study-ai-item.ts':{useReportStudyAIItem(){}},'app/assistance-display.tsx':{useAssistance:()=>({submit(){}}),useAssistanceDisplay(){}},
    'app/components/code-editor.tsx':{CodeEditor:()=>null},'app/study-guidance.tsx':{StudyGuidance:()=>null},'src/features/remediation/index.ts':{CodeRewriteLauncher:()=>null},'app/math-text.tsx':{MathText:()=>null}});
  const store=load('app/learning-draft-store.ts').createLearningDraftStore('recover-'+state),draft=store.adapter('owner','code');
  draft.write('firstRunKind',state);draft.write('firstNeedsReview',state==='pending');draft.write('firstTestCode','def f():\n return 1');
  const lifecycle={ready:true,purpose:'first',intent:'review',submitted:true,practice:{snapshot:()=>null,async codeFeedback(){return{first,latest,output:'restored output',firstState:{status:state,explanation:'original evaluation'}};}}};
  hooks.mount(load('app/plugins/plugin-code.tsx').CodePlugin.renderUI,{data:{topic:'Python',prompt:'Return one',initialCode:'def f():\n return 1',testCode:'assert f()==1',solutionCode:'',explanation:''},context:{draft,nonWordLearning:lifecycle},onGrade(){throw Error('restore must not grade');}});
  for(let i=0;i<4;i++){hooks.flush();await tick();hooks.render();}
  const run=[...nodes(hooks.view())].find(n=>n.type==='button'&&text(n).includes('运行测试'));
  return {hooks,run,body:text(hooks.view()),draft};
}
test('resolved original evaluation survives refresh even when its first run report was unknown',async()=>{
  const f=await mount({first:unknown,latest:passed,state:'correct'});
  try{assert.equal(f.run.props.disabled,true);assert.equal(f.draft.read('firstRunKind',''),'correct');assert.doesNotMatch(f.body,/保留待核对结果/);}finally{f.hooks.unmount();}
});
test('a passed saved report without a durable evaluation remains pending and retryable after refresh',async()=>{
  const f=await mount({first:passed,latest:passed,state:'pending'});
  try{assert.equal(f.run.props.disabled,false);assert.equal(f.draft.read('firstRunKind',''),'pending');assert.match(f.body,/待核对/);}finally{f.hooks.unmount();}
});
