import {test} from 'node:test';
import assert from 'node:assert/strict';
import {shouldAutoOpenOnboarding,readOnboarding,saveOnboarding,chooseOnboardingProgress,prepareOnboardingLogin,cancelOnboardingLogin,onboardingStudyHref,consumeOnboardingLogin,initialOnboarding} from '../app/onboarding-state.ts';
const storage=()=>{const values=new Map();return {getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v),removeItem:k=>values.delete(k)};};
test('first visits show the tutorial and skipped/completed records remain account-scoped',()=>{
  const s=storage();assert.equal(readOnboarding(s,'guest'),null);
  const progress={...initialOnboarding(),step:2,status:'skipped'};assert.equal(saveOnboarding(s,'account-a',progress),true);
  assert.deepEqual(readOnboarding(s,'account-a'),progress);assert.equal(readOnboarding(s,'account-b'),null);
});
test('explicit login handoff resumes once and cannot linger for another account',()=>{
  const s=storage(),progress={...initialOnboarding(),step:4,path:'existing'};
  prepareOnboardingLogin(s,progress,1000);assert.equal(consumeOnboardingLogin(s,null,1200),null);
  assert.deepEqual(consumeOnboardingLogin(s,'account-a',1200),progress);assert.equal(consumeOnboardingLogin(s,'account-b',1300),null);
  prepareOnboardingLogin(s,progress,1000);assert.equal(consumeOnboardingLogin(s,'account-a',2000000),null);
});
test('invalid records and unavailable browser storage never block using the site',()=>{
  const s=storage();saveOnboarding(s,'guest',{step:999,status:'completed'});assert.equal(readOnboarding(s,'guest'),null);
  assert.equal(saveOnboarding({setItem(){throw Error('blocked');}},'guest',initialOnboarding()),false);
});
test('a deliberate skip or completion cancels an abandoned login handoff',()=>{
  const s=storage();prepareOnboardingLogin(s,{...initialOnboarding(),step:3},1000);cancelOnboardingLogin(s);assert.equal(consumeOnboardingLogin(s,'account-a',1200),null);
});
test('finishing on a non-default Companion keeps its endpoint through navigation',()=>{
  const url=new URL(onboardingStudyHref('?companionPort=43265',true),'https://example.test');assert.equal(url.searchParams.get('pair'),'1');assert.equal(url.searchParams.get('companionPort'),'43265');
  assert.equal(new URL(onboardingStudyHref('?companionPort=unsafe'),'https://example.test').searchParams.get('companionPort'),'43121');
});
test('a guest acknowledgement avoids a second automatic tutorial without downgrading prior completion',()=>{
  const skipped={...initialOnboarding(),status:'skipped'},complete={...initialOnboarding(),step:6,status:'completed'};
  assert.equal(chooseOnboardingProgress(null,skipped).status,'skipped');assert.deepEqual(chooseOnboardingProgress(complete,skipped),complete);
  assert.equal(chooseOnboardingProgress(complete,{...initialOnboarding(),step:3}).step,3);
});

test('anonymous homepage shows the homepage without automatically covering it with onboarding',()=>{
 assert.equal(shouldAutoOpenOnboarding(initialOnboarding(),false,'/'),false);
 assert.equal(shouldAutoOpenOnboarding(initialOnboarding(),true,'/study'),false);
 assert.equal(shouldAutoOpenOnboarding({...initialOnboarding(),status:'completed'},true,'/study'),false);
});
test('public information pages and signed-out visitors never receive an automatic tutorial',()=>{
 // The tutorial used to cover /help, /updates and /companion-guide on a first visit; those pages
 // must stay readable until the learner opens the tutorial from a visible control.
 for(const pathname of ['/','/help','/updates','/companion-guide','/help?topic=sync','/updates/','/progress','/companion-guide/install']){
  assert.equal(shouldAutoOpenOnboarding(initialOnboarding(),true,pathname),false,`${pathname} must stay closed`);
  assert.equal(shouldAutoOpenOnboarding(initialOnboarding(),false,pathname),false,`${pathname} must stay closed for guests`);
 }
 assert.equal(shouldAutoOpenOnboarding(initialOnboarding(),false,'/study'),false);
 assert.equal(shouldAutoOpenOnboarding(initialOnboarding(),true,'/study'),false);
 assert.equal(shouldAutoOpenOnboarding(initialOnboarding(),true,'/study/',true),true);
 assert.equal(shouldAutoOpenOnboarding(initialOnboarding(),true,'/study?pair=1',true),true);
 assert.equal(shouldAutoOpenOnboarding(initialOnboarding(),true,'/study#today',true),true);
});


test('automatic tutorial only resumes explicit prior intent, never a fresh arrival',()=>{
 assert.equal(shouldAutoOpenOnboarding(initialOnboarding(),true,'/study',true),true);
 assert.equal(shouldAutoOpenOnboarding(initialOnboarding(),true,'/study',false),false);
 assert.equal(shouldAutoOpenOnboarding(initialOnboarding(),false,'/study',true),false);
 assert.equal(shouldAutoOpenOnboarding({...initialOnboarding(),status:'skipped'},true,'/study',true),false);
 assert.equal(shouldAutoOpenOnboarding({...initialOnboarding(),status:'completed'},true,'/study',true),false);
});
