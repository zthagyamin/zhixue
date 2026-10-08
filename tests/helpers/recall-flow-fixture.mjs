// Real RecallUI, real draft store and useRecallSupport. Deterministic hooks/network/storage adapters.
import {createHooks,loader,nodes,text,button,deferred,tick,extract,waitForObservation} from './causal-harness.mjs';
export {nodes,text,button,deferred,tick};
export async function settle(f){for(let i=0;i<4;i++){f.hooks.flush();await tick();f.hooks.render();}}
export function recallFixture({data={},gradeRecall,failSaves=0,manualSave=false,support=false}={}){
 const hooks=createHooks(),records=[],attempts=[],moves=[],waits=[];let failures=failSaves;
 const hintState={schemaVersion:1,attemptId:'synthetic-attempt',maxPreHintLevel:0};
 const window={confirm:()=>true,addEventListener(){},removeEventListener(){}};
 const errors=extract('app/account-study-runtime.ts','accountAiFailureMessage')({});
 const load=loader(hooks.api,{
  'app/study-guidance.tsx':{StudyGuidance:()=>null},
  'app/ai/use-report-study-ai-item.ts':{useReportStudyAIItem:()=>{}},
  'app/assistance-display.tsx':{useAssistance:d=>d?.assistance,useAssistanceDisplay:()=>{}},
  'app/math-text.tsx':{MathText:()=>null},'app/plugins/tutor-follow-up.tsx':{TutorFollowUp:()=>null},
  'app/account-study-runtime.ts':{accountAiFailureMessage:errors},
  'app/recall-attempt-state.ts':{openRecallAttempt:async()=>({...hintState}),recordRecallHint:async(_s,_i,l)=>{hintState.maxPreHintLevel=Math.max(hintState.maxPreHintLevel,l);return {...hintState};}},
  'app/study-submission-journal.ts':{createSubmissionJournal:()=>({list:async()=>[]})},
 },window);
 const store=load('app/learning-draft-store.ts').createLearningDraftStore('test-owner-library'),draft=store.adapter('question-A','recall:1');
 const Plugin=load('app/plugin-recall.tsx').RecallPlugin;
 const props={data:{itemId:'A',fingerprint:'v1',prompt:'解释这个概念。',explanation:'参考要点：定义与适用条件。',...(support?{learningSupport:{schemaVersion:1,type:'recall',criteria:[{id:'definition',text:'定义'}],hints:['方向','结构','完整答案']}}:{}),...data},
 context:{draft,guidanceInOptions:true,gradeRecall,recallPersistenceRequired:false,recallNavigation:{continueLabel:'结束本轮',onSkip:()=>moves.push('skip')}},
 onGrade:(rating,options)=>{const ticket=draft.begin();if(!ticket)return;attempts.push(rating);
  const commit=()=>{if(store.commit(ticket,options?.deferAdvance?()=>moves.push('continue'):undefined))records.push(rating);};
  if(failures>0){failures--;store.fail(ticket);return;}
  if(manualSave){const wait=deferred();waits.push(wait);void wait.promise.then(commit,()=>store.fail(ticket));}else commit();
 }};
 hooks.mount(Plugin.renderUI,props);
 return {hooks,load,Plugin,props,store,draft,records,attempts,moves,waits,hintState,view:()=>hooks.view(),button:name=>button(hooks.view(),name),async type(value){[...nodes(hooks.view())].find(n=>n.type==='textarea').props.onChange({target:{value}});hooks.render();},async click(name){
   let target=button(hooks.view(),name);
   // Event handlers may start WebCrypto-backed work without returning its promise.
   // Await the requested actionable control, retaining the failure and disabled assertions.
   for(let turn=0;(!target||target.props.disabled)&&turn<100;turn++){await settle(this);target=button(hooks.view(),name);}
   if(!target)throw Error('Button missing: '+name);if(target.props.disabled)throw Error('Button disabled: '+name);
   const pending=target.props.onClick();hooks.render();await settle(this);
   if(name==='收起讲解，再试一次'){
     // This void handler saves the parent before asynchronously mounting a new child fixture.
     // Observe the current fixture: the captured parent hooks no longer own the editable input.
     await waitForObservation(()=>settle(this),()=>this.props.context?.nonWordLearning?.purpose==='remediation'
       &&[...nodes(this.view())].some(node=>node.type==='textarea'&&!node.props.disabled),
       {label:'Requested remediation child editable input'});
   }
   if(['提交并核对','想好了，核对要点','忘记了，查看要点'].includes(name)){
     const deadline=Date.now()+10000;
     while(text(hooks.view()).includes('正在核对')&&Date.now()<deadline)await settle(this);
     if(text(hooks.view()).includes('正在核对'))throw Error('Requested recall action has not acknowledged its saved answer: '+name);
   }
   return pending;
 }};
}
