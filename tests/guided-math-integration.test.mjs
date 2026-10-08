import test from 'node:test';
import assert from 'node:assert/strict';
import {createHooks,loader,nodes} from './helpers/causal-harness.mjs';
import {mathFingerprint} from '../src/domain/guided-math/index.ts';
test('the actual calculation bridge uses contentHash or a real visible-content snapshot, never legacy fingerprint',async()=>{
 const hooks=createHooks(),load=loader(hooks.api,{
  'app/study-guidance.tsx':{StudyGuidance:()=>null},
  'app/ai/use-report-study-ai-item.ts':{useReportStudyAIItem:()=>{}},
  'app/math-text.tsx':{MathText:()=>null},
  'app/plugins/tutor-follow-up.tsx':{TutorFollowUp:()=>null},
 },{addEventListener(){},removeEventListener(){}});
 const store=load('app/learning-draft-store.ts').createLearningDraftStore('scope'),draft=store.adapter('a','calculation');
 draft.read('result',null);draft.write('result',{correct:false,explanation:'reference'});store.commit(draft.begin(),()=>{});
 const Plugin=load('app/plugin-calculation.tsx').CalculationPlugin.renderUI;
 const data={itemId:'a',fingerprint:'same-point-and-path',prompt:'2+2',answer:'4'};
 const props={data,context:{draft},onGrade(){}};hooks.mount(Plugin,props);
 const source=()=>[...nodes(hooks.view())].find(node=>node.props?.source?.snapshot)?.props.source;
 const first=source();assert.equal(first.contentHash,undefined);
 hooks.render({...props,data:{...data,prompt:'3+3',answer:'6'}});
 const second=source();assert.notEqual(await mathFingerprint(first.snapshot),await mathFingerprint(second.snapshot));
 hooks.render({...props,context:{draft,contentSource:{mode:'calculation',data:{...data,contentHash:'approved-content-v2'}}}});
 assert.equal(source().contentHash,'approved-content-v2');hooks.unmount();
});
