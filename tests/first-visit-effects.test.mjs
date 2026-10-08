import test from 'node:test';
import assert from 'node:assert/strict';
import {tsxFunction} from './fixtures/tsx-functions.mjs';
function harness(overrides={}){
 let visible=false,frame;const attempted={current:false};
 class HTMLElement {matches(){return false;}}
 const env={ready:true,blocked:false,scope:'account:a',attempted,arrival:{scope:'account:a',visit:{announcementVersion:'1.37.0'},tutorialOpen:false},
  current:{version:'1.37.0'},receipt:{hasRead:()=>false},document:{querySelector:()=>null,activeElement:null,visibilityState:'visible'},HTMLElement,
  window:{requestAnimationFrame:fn=>{frame=fn;return 1;},cancelAnimationFrame:()=>{frame=undefined;}},setVisible:value=>{visible=value;},...overrides};
 const effect=()=>tsxFunction(new URL('../app/release-announcement.tsx',import.meta.url),'ReleaseAnnouncement',env,{effect:'attempted.current'})();
 return {env,effect,runFrame:()=>{const fn=frame;frame=undefined;fn?.();},visible:()=>visible};
}
test('release automatic effect stays silent on the first version but permits an actual upgrade',()=>{
 const fresh=harness({arrival:{scope:'account:a',visit:{announcementVersion:null},tutorialOpen:false}});fresh.effect();fresh.runFrame();assert.equal(fresh.visible(),false);
 const returning=harness();returning.effect();returning.runFrame();assert.equal(returning.visible(),true);
});
test('automatic release waits for identity and never borrows another account\'s arrival',()=>{
 const h=harness({ready:false});h.effect();h.runFrame();assert.equal(h.visible(),false);assert.equal(h.env.attempted.current,false);
 h.env.ready=true;h.env.arrival.scope='account:other';h.effect();h.runFrame();assert.equal(h.visible(),false);
 h.env.arrival.scope='account:a';h.effect();h.runFrame();assert.equal(h.visible(),true);
});
for(const cause of ['busy','tutorial'])test(`a ${cause} session suppresses this visit, not queues another modal`,()=>{
 const h=harness();if(cause==='busy')h.env.blocked=true;else h.env.arrival.tutorialOpen=true;
 h.effect();h.runFrame();assert.equal(h.visible(),false);
 h.env.blocked=false;h.env.arrival.tutorialOpen=false;h.effect();h.runFrame();assert.equal(h.visible(),false);
});
for(const cause of ['dialog','hidden','typing','read'])test(`automatic announcement yields to ${cause}`,()=>{
 const h=harness();if(cause==='dialog')h.env.document.querySelector=()=>({open:true});
 if(cause==='hidden')h.env.document.visibilityState='hidden';
 if(cause==='typing'){h.env.document.activeElement=new h.env.HTMLElement();h.env.document.activeElement.matches=()=>true;}
 if(cause==='read')h.env.receipt.hasRead=()=>true;
 h.effect();h.runFrame();assert.equal(h.visible(),false);
});
test('effect cleanup cancels stale rendering without consuming a StrictMode replay',()=>{
 const h=harness();const cleanup=h.effect();cleanup();h.runFrame();assert.equal(h.visible(),false);assert.equal(h.env.attempted.current,false);
 h.effect();h.runFrame();assert.equal(h.visible(),true);
});
