import assert from 'node:assert/strict';
import test from 'node:test';
import {recallFixture,settle,nodes} from './helpers/recall-flow-fixture.mjs';
import {createLearningDraftStore} from '../app/learning-draft-store.ts';
import {registerStudyNavigationGuard,prepareStudyNavigation} from '../app/study-navigation-guard.ts';
const launcher=f=>[...nodes(f.view())].find(node=>node.props?.label==='保留本次结果，针对要点补练');

test('again saves once before remediation, returns to the same feedback, then continues with no second event',async()=>{
 const f=recallFixture({manualSave:true,gradeRecall:async()=>({source:'ai',verdict:'incorrect',rating:'again'})});
 await settle(f);await f.type('first answer');await f.click('提交并核对');
 const pending=launcher(f).props.beforeOpen(new AbortController().signal);await settle(f);
 assert.deepEqual(f.attempts,['again']);assert.deepEqual(f.records,[]);assert.deepEqual(f.moves,[]);
 f.waits[0].resolve();assert.equal(await pending,true);await settle(f);
 assert.deepEqual(f.records,['again']);assert.deepEqual(f.moves,[]);
 const draft=launcher(f).props.createDraft({reason:''});draft.write('reason','assisted explanation');
 assert.equal(f.draft.read('answer',''),'first answer');assert.equal(f.draft.write('answer','changed'),false);
 draft.acknowledge();draft.dispose();await f.click('结束本轮');
 assert.deepEqual(f.records,['again']);assert.deepEqual(f.moves,['continue']);f.hooks.unmount();
});
test('cancelled remediation preparation does not undo a durable original result or force navigation',async()=>{
 const f=recallFixture({manualSave:true});await settle(f);await f.click('忘记了，查看要点');
 const controller=new AbortController(),pending=launcher(f).props.beforeOpen(controller.signal);await settle(f);
 controller.abort();assert.equal(await pending,false);f.waits[0].resolve();await settle(f);
 assert.deepEqual(f.records,['again']);assert.deepEqual(f.moves,[]);await f.click('看完了，结束本轮');assert.deepEqual(f.records,['again']);f.hooks.unmount();
});
test('new edits in an already dirty temporary draft require fresh navigation consent',()=>{
 const store=createLearningDraftStore(),parent=store.adapter('a','recall'),draft=parent.createTemporary({reason:''});
 draft.write('reason','first');let asks=0;
 const unregister=registerStudyNavigationGuard({message:()=>store.hasUnsavedInput()?'dirty':null,version:store.getSnapshot,onLeave:()=>store.clear()});
 try{const leave=prepareStudyNavigation(()=>{asks++;return true;});draft.write('reason','newer');assert.equal(leave(),true);assert.equal(asks,2);assert.equal(draft.isActive(),false);}finally{unregister();}
});
