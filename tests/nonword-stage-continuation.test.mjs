import test from 'node:test';
import assert from 'node:assert/strict';
import {dashboardValue,dashboardModuleKey} from './fixtures/dashboard-functions.mjs';
import {createLearningDraftStore} from '../app/learning-draft-store.ts';
import {createSubjectGradeHandler} from '../src/features/study-attempt/index.ts';
import {completesSubjectItemAfterAttempt,reviewDisplayStage} from '../src/domain/planning/index.ts';

function display(mode,stage,item,subject={pluginType:mode},quickReview=false){
  return dashboardValue('currentStage',{actualPluginType:mode,completedStage:stage,currentItem:item,subject,quickReview,
    completesSubjectItemAfterAttempt,reviewDisplayStage});
}
function key(mode,stage,item){return dashboardModuleKey({subject:{id:'synthetic-subject'},itemProgressKey:'q',
  actualPluginType:mode,currentStage:display(mode,stage,item),stageRoundBump:0});}

for(const mode of ['quiz','flashcard','code'])test(`nonword ${mode} saved progress cannot replace its continuation view`,async()=>{
  const item={questionType:mode,eventKind:'due'},drafts=createLearningDraftStore('synthetic-stage'),
    draft=drafts.adapter('q',mode+':'+display(mode,0,item));
  let stage=0,advances=0,writes=0;
  let published;const progressPublished=new Promise(resolve=>{published=resolve;});
  const captured=key(mode,stage,item);
  const grade=createSubjectGradeHandler({mode,completedStage:stage,isDemoMode:false,draft},{
    drafts,modeEpoch:()=>0,ownerCurrent:()=>true,canPresent:()=>key(mode,stage,item)===captured,
    prepare:(request,rating)=>({input:{identity:request.identity,rating},frame:{},observation:null}),
    advance:()=>{advances++;return true;},publishDemo(){},setMessage(){},invalidateView(){},
    record:async(input,ports)=>{await ports.persistEvent({eventId:input.identity.eventId,event:input});await ports.persistProgress({event:input});},
    persist:async()=>{writes++;return{};},publishEvent(){},publishProgress:()=>{stage=3;published();},
    sendCloud:async()=>{},sendCompanion:async()=>{},updateDelivery:async()=>{},
  });
  const result=await grade('good',{deferAdvance:true,continuationReceipt:true});
  await progressPublished;
  assert.equal(result.status,'saved');assert.equal(stage,3);assert.equal(advances,0);assert.equal(draft.hasSavedFeedback(),true);
  assert.equal(draft.continueAfterFeedback(),true,'The real durable continuation must still own the same visible view');
  assert.equal(draft.continueAfterFeedback(),false);assert.equal(advances,1);assert.equal(writes,1);
});

test('original vocabulary retains stage display when shown as quiz or flashcard',()=>{
  for(const mode of ['quiz','flashcard','code'])for(const item of [{word:'tree',questionType:mode},{eventKind:'word',questionType:mode}])
    for(const stage of [0,1,2,3])assert.equal(display(mode,stage,item),Math.min(3,stage+1));
  for(const quick of [false,true])for(const stage of [0,1,2,3])
    assert.equal(display('three-stage',stage,{word:'tree'},{pluginType:'three-stage'},quick),reviewDisplayStage(stage,quick));
  for(const mode of ['calculation','recall'])for(const stage of [0,3])assert.equal(display(mode,stage,{word:'tree'}),1);
});
