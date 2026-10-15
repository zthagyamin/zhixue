import test from 'node:test';
import assert from 'node:assert/strict';
import {createHooks,loader,nodes} from './helpers/causal-harness.mjs';

function fixture({original,rawWord=false}={}){
 const hooks=createHooks();
 function MathText(){return null;}
 const load=loader(hooks.api,{
  'app/math-text.tsx':{MathText},
  'app/study-guidance.tsx':{StudyGuidance:()=>null},
  'app/ai/use-report-study-ai-item.ts':{useReportStudyAIItem(){}},
  'app/assistance-display.tsx':{useAssistance:()=>null,useAssistanceDisplay(){}},
  'app/calculation-exploration.tsx':{CalculationExploration:()=>null},
  'src/features/guided-math/index.ts':{MathPracticeLauncher:()=>null},
  'src/features/remediation/index.ts':{SourceReviewLauncher:()=>null},
  'app/plugins/tutor-follow-up.tsx':{TutorFollowUp:()=>null},
 });
 const data={itemId:'synthetic-half',prompt:'计算 $\frac{1}{2}$ 的数值。',answer:'0.5',
             ...(rawWord?{word:'fraction',meaning:'分数'}:{})};
 hooks.mount(load('app/plugin-calculation.tsx').CalculationPlugin.renderUI,{
  data,context:{...(original?{contentSource:original}:{}),gradeCalculation:async()=>{throw Error('not used');}},
  onGrade:()=>assert.fail('rendering cannot grade')});
 hooks.flush();
 return {hooks,data,MathText,heading:()=>[...nodes(hooks.view())].find(node=>node.type==='h2')};
}

test('legacy nonword calculation selects formula rendering without a persistence host',()=>{
 const f=fixture();
 assert.ok([...nodes(f.heading())].some(node=>node.type===f.MathText&&node.props.text===f.data.prompt));
 f.hooks.unmount();
});

test('original vocabulary keeps plain text when presentation is calculation',()=>{
 for(const original of [
  {mode:'quiz',data:{kind:'word',word:'fraction',meaning:'分数'}},
  {mode:'recall',data:{eventKind:'word',word:'fraction'}},
  {mode:'quiz',data:{pluginType:'spelling',prompt:'original lexical text'}},
 ]){
  const f=fixture({original});
  assert.equal([...nodes(f.heading())].some(node=>node.type===f.MathText),false);
  assert.equal(f.heading().props.children,f.data.prompt);
  f.hooks.unmount();
 }
});

test('raw vocabulary markers stay lexical even without original context',()=>{
 const f=fixture({rawWord:true});
 assert.equal([...nodes(f.heading())].some(node=>node.type===f.MathText),false);
 assert.equal(f.heading().props.children,f.data.prompt);
 f.hooks.unmount();
});
