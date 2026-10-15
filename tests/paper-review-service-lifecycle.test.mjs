import test from 'node:test';
import assert from 'node:assert/strict';
import {createHooks,extract,nodes,text,deferred,tick,waitForObservation} from './helpers/causal-harness.mjs';
import * as study from '../app/paper-study.ts';
import * as templates from '../app/paper-slot-templates.ts';
import {createPaperWorkshopReview,createPaperWorkshopReviewGuard} from '../app/paper-reading/review.ts';

function fixture(){
 const hooks=createHooks(),gate=deferred(),reviews=[],calls=[],paper=structuredClone(study.DEMO_PAPER_ALEXNET);
 let state={ready:true,saving:false,error:'',draft:study.emptyPaperDraft()};
 const session={subscribe:()=>()=>{},snapshot:()=>state,isExclusive:()=>false,update:async change=>{state={...state,draft:change(state.draft)};}};
 const ai={settings:{enabled:true,configured:true,provider:'deepseek',model:'fixture',revision:1},service:{async *chat(request,signal){calls.push({request,signal});yield {type:'delta',text:'partial'};await gate.promise;yield {type:'delta',text:' complete'};}}};
 const jsx=(type,props)=>({type,props});
 const component=extract('app/plugins/plugin-paper.tsx','PaperEditor')({...hooks.api,...study,...templates,
  createPaperWorkshopReviewGuard,createPaperWorkshopReview:options=>{const service=createPaperWorkshopReview(options);reviews.push(service);return service;},
  useOptionalStudyAIWorkspace:()=>ai,figureReferences:()=>[],paperRetestSeeds:()=>[],registerStudyNavigationGuard:()=>()=>{},
  StudyGuidance:'Guidance',StudyGuidanceHelp:'Help',PaperSourceText:'SourceText',MathText:'MathText',PaperWorkspacePanels:'Panels',PaperSelectionToolbar:'Selection',PaperFigurePanel:'Figure',CandidateLauncher:'Candidate',PaperNoteSavePanel:'Save',
  exports:{},require:()=>({jsx,jsxs:jsx}),window:{confirm:()=>true},
 });
 let props={paper,session,services:{owner:'test-owner',library:'test-library',isCurrent:()=>true}};
 function render(services){if(services)props={...props,services};hooks.render(props);hooks.flush();return hooks.render();}
 hooks.mount(component,props);hooks.flush();
 function start(){const panel=[...nodes(render())].find(n=>n.type==='Panels');const chip=[...nodes(panel.props.board)].find(n=>n.type==='button'&&text(n)===templates.paperReviewerActions('empirical')[0]);assert.ok(chip);chip.props.onClick();}
 return {hooks,gate,reviews,calls,render,start};
}
test('new equivalent host callbacks keep the same in-flight reviewer and streamed reference',async()=>{
 const f=fixture();f.start();await waitForObservation(tick,()=>f.reviews[0].snapshot().text==='partial');
 f.render({owner:'test-owner',library:'test-library',isCurrent:()=>true});
 assert.equal(f.reviews.length,1);assert.equal(f.calls[0].signal.aborted,false);assert.equal(f.reviews[0].snapshot().text,'partial');
 f.gate.resolve();await waitForObservation(tick,()=>f.reviews[0].snapshot().status==='idle');
 assert.equal(f.reviews[0].snapshot().text,'partial complete');f.hooks.unmount();
});
test('replacement host callback updates the live guard and rejects late output',async()=>{
 const f=fixture();f.start();await waitForObservation(tick,()=>f.reviews[0].snapshot().text==='partial');
 f.render({owner:'test-owner',library:'test-library',isCurrent:()=>false});assert.equal(f.reviews.length,1);
 f.gate.resolve();await waitForObservation(tick,()=>f.reviews[0].snapshot().status==='idle');
 assert.equal(f.reviews[0].snapshot().text,'');assert.equal(f.calls[0].signal.aborted,true);f.hooks.unmount();
});
