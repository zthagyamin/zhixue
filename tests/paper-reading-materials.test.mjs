import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {parsePaperStudyData} from '../app/paper-study.ts';
import {createHooks,loader,tick,deferred,waitForObservation} from './helpers/causal-harness.mjs';
const material=id=>parsePaperStudyData({paperId:id,title:'Synthetic '+id,sections:[{id:'s',title:'Synthetic source',paragraphs:[{id:'p',rawEn:'Original synthetic source for '+id+'.'}]}]});
const surface={addEventListener(){},removeEventListener(){}};
test('changing owner or library hides the prior draft before async source loading completes',async()=>{
 globalThis.indexedDB=new IDBFactory();
 const hooks=createHooks(),paper=material('same'),load=loader(hooks.api,{},surface);
 const {usePaperReadingMaterials}=load('app/paper-reading/use-materials.ts');
 const Component=services=>usePaperReadingMaterials(services,paper);
 const settle=owner=>waitForObservation(async()=>{await tick();hooks.render();hooks.flush();},()=>hooks.render().session?.owner===owner);
 hooks.mount(Component,{owner:'first',library:'one'});hooks.flush();await settle('first');
 assert.equal(hooks.render().session.owner,'first');
 assert.equal(hooks.render({owner:'second',library:'one'}).session,null);
 hooks.flush();await settle('second');assert.equal(hooks.render().session.owner,'second');
 assert.equal(hooks.render({owner:'second',library:'two'}).session,null);hooks.flush();
 await waitForObservation(async()=>{await tick();hooks.render();hooks.flush();},()=>Boolean(hooks.render().session?.kind.includes('"two"')));
 assert.equal(hooks.render().session.owner,'second');hooks.unmount();
});

test('a late original-cache receipt cannot undo the latest material selection',async()=>{
 globalThis.indexedDB=new IDBFactory();
 const hooks=createHooks(),cache=deferred(),entered=deferred();
 const initial=material('initial'),selected=material('selected'),imported=parsePaperStudyData({...material('imported'),origin:{kind:'upload',version:'a'.repeat(64)}});
 const load=loader(hooks.api,{
  'app/paper-reading/original-cache.ts':{createPaperOriginalCache:()=>({save:async()=>{entered.resolve();await cache.promise;}})},
 },surface);
 const {usePaperReadingMaterials}=load('app/paper-reading/use-materials.ts');
 const Component=services=>usePaperReadingMaterials(services,initial);
 const render=()=>{hooks.render();hooks.flush();return hooks.render();};
 hooks.mount(Component,{owner:'u',library:'l'});hooks.flush();
 await waitForObservation(async()=>{await tick();render();},()=>Boolean(render().session));
 const pending=render().add(imported,{name:'paper.pdf',arrayBuffer:async()=>new Uint8Array([1]).buffer});
 await entered.promise;await render().choose(selected);render();assert.equal(render().paper.paperId,'selected');
 cache.resolve();await pending;assert.equal(render().paper.paperId,'selected');hooks.unmount();
});
