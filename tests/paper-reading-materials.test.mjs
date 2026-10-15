import test from 'node:test';
import assert from 'node:assert/strict';
import {createHooks,loader,tick,deferred} from './helpers/causal-harness.mjs';
test('changing owner or library hides the prior draft before async source loading completes',async()=>{
 const hooks=createHooks(),paper={paperId:'same',title:'Same paper',sections:[]};
 const load=loader(hooks.api,{
  'app/paper-study.ts':{DEMO_PAPER_ALEXNET:paper},
  'app/paper-draft-store.ts':{loadPaperMaterials:async()=>[],openPaperDraft:async(owner,library)=>({owner,library,flush:async()=>{}})},
  'app/paper-reading/original-cache.ts':{createPaperOriginalCache:()=>({})},
 });
 const {usePaperReadingMaterials}=load('app/paper-reading/use-materials.ts');
 const Component=services=>usePaperReadingMaterials(services,paper);
 hooks.mount(Component,{owner:'first',library:'one'});hooks.flush();await tick();
 assert.equal(hooks.render().session.owner,'first');
 assert.equal(hooks.render({owner:'second',library:'one'}).session,null);
 hooks.flush();await tick();assert.equal(hooks.render().session.owner,'second');
 assert.equal(hooks.render({owner:'second',library:'two'}).session,null);hooks.unmount();
});

test('a late original-cache receipt cannot undo the latest material selection',async()=>{
 const hooks=createHooks(),cache=deferred(),entered=deferred();
 const initial={paperId:'initial',title:'Initial',sections:[]},selected={...initial,paperId:'selected'},imported={...initial,paperId:'imported',origin:{kind:'upload',version:'a'.repeat(64)}};
 const load=loader(hooks.api,{
  'app/paper-study.ts':{DEMO_PAPER_ALEXNET:initial},
  'app/paper-draft-store.ts':{loadPaperMaterials:async()=>[],openPaperDraft:async()=>({flush:async()=>{}}),savePaperMaterial:async(_owner,_library,paper)=>({fingerprint:paper.paperId,paper})},
  'app/paper-reading/original-cache.ts':{createPaperOriginalCache:()=>({save:async()=>{entered.resolve();await cache.promise;}})},
 });
 const {usePaperReadingMaterials}=load('app/paper-reading/use-materials.ts');
 const Component=services=>usePaperReadingMaterials(services,initial);
 const render=()=>{hooks.render();hooks.flush();return hooks.render();};
 hooks.mount(Component,{owner:'u',library:'l'});hooks.flush();await tick();render();
 const pending=render().add(imported,{name:'paper.pdf',arrayBuffer:async()=>new Uint8Array([1]).buffer});
 await entered.promise;await render().choose(selected);render();assert.equal(render().paper.paperId,'selected');
 cache.resolve();await pending;assert.equal(render().paper.paperId,'selected');hooks.unmount();
});
