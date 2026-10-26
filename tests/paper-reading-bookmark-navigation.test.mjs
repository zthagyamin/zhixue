import test from 'node:test';
import assert from 'node:assert/strict';
import {IDBFactory} from 'fake-indexeddb';
import {createHooks,loader,extract,deferred,tick,waitForObservation,text,button} from './helpers/causal-harness.mjs';
import {parsePaperStudyData} from '../app/paper-study.ts';
import {savePaperMaterial,loadPaperMaterials,openPaperDraft,paperFingerprint} from '../app/paper-draft-store.ts';
import {createPaperReadingUnit} from '../src/domain/paper-reading/unit.ts';
import {loadPaperReadingBookmarks,savePaperReadingBookmark,paperReadingBookmarkFor} from '../app/paper-reading/bookmark.ts';
import {saveWorkspaceRecord} from '../app/local-study-db.ts';
import {createPaperReadingSession} from '../src/application/paper-reading/session.ts';
import {createPaperReadingStore} from '../app/paper-reading/store.ts';
import {paperReadingTask} from '../src/domain/paper-reading/evidence.ts';

const material=title=>parsePaperStudyData({paperId:title,title,sections:[{id:'s',title:'Synthetic section',paragraphs:[1,2,3].map(n=>({id:'p'+n,rawEn:`Original synthetic ${title} paragraph ${n}.`}))}]});
let serial=0;
function scope(){return {owner:'audit:bookmark-'+(++serial),library:'audit:library'};}
function reset(){globalThis.indexedDB=new IDBFactory();}
function hook(services,initialPaper,overrides={}){
 const hooks=createHooks(),load=loader(hooks.api,overrides,{addEventListener(){},removeEventListener(){}});
 const useMaterials=load('app/paper-reading/use-materials.ts').usePaperReadingMaterials;
 const render=()=>{const value=hooks.render();hooks.flush();return value;};
 hooks.mount(props=>useMaterials(props.services,props.initialPaper),{services,initialPaper});hooks.flush();
 return {hooks,render,rebind(next){const value=hooks.render({services:next});hooks.flush();return value;},async ready(){await waitForObservation(async()=>{await tick();render();},()=>{
  const value=render();return Boolean(value.session?.snapshot().ready&&(initialPaper||value.materials.some(row=>row.paper.paperId===value.paper.paperId)));
 });return render();}};
}
function reader(model,services){
 const hooks=createHooks(),jsx=(type,props)=>({type,props}),guards=[],events=new Map();
 const component=extract('app/paper-reading/entry.tsx','ReadingDocument')({...hooks.api,
  usePaperClock:()=>({controls:null,details:null,flush:async()=>{},persist:async()=>{}}),createPaperReadingUnit,
  PaperReadingPage:'Page',PaperOriginalPage:'Original',PaperQuestionEntry:'Question',ReadingBackupControls:'Backup',PaperSourceText:'Text',MathText:'Math',
  createPaperOriginalCache:()=>({}),verifiedPaperScope:()=>{},confirmStudyNavigation:()=>true,
  registerStudyNavigationGuard:guard=>{guards.push(guard);return()=>{};},window:{addEventListener(name,callback){events.set(name,callback);},removeEventListener(name){events.delete(name);}},document:{activeElement:null},HTMLButtonElement:class {},
  exports:{},require:()=>({jsx,jsxs:jsx}),
 });
 const props={paper:model.paper,session:model.session,services,sources:null,bookmark:model.bookmark,onBookmark:model.remember,resume:model.resume};
 hooks.mount(component,props);hooks.flush();
 const render=()=>{const view=hooks.render();hooks.flush();return view.type==='Page'?view.props:view.props.children.find?.(x=>x?.type==='Page')?.props;};
 return {hooks,render,guards,events};
}

test('choosing A after importing A then B survives a fresh materials hook without rewriting material order',async()=>{
 reset();const services=scope(),a=material('A'),b=material('B');
 await savePaperMaterial(services.owner,services.library,a);await savePaperMaterial(services.owner,services.library,b);
 const first=hook(services);assert.equal((await first.ready()).paper.title,'B');
 await first.render().choose(a);assert.equal(first.render().paper.title,'A');first.hooks.unmount();
 const refreshed=hook(services);assert.equal((await refreshed.ready()).paper.title,'A');refreshed.hooks.unmount();
 assert.deepEqual((await loadPaperMaterials(services.owner,services.library)).map(row=>row.paper.title),['B','A']);
});

test('a two-paragraph range survives reader disposal and a fresh origin-backed materials hook',async()=>{
 reset();const services=scope(),paper=material('Range');await savePaperMaterial(services.owner,services.library,paper);
 const first=hook(services),view=reader(await first.ready(),services);view.render().onCount(2);
 await waitForObservation(async()=>{await tick();view.render();},()=>view.render().unit.paragraphs.length===2);
 view.hooks.unmount();first.hooks.unmount();
 const refreshed=hook(services),restored=reader(await refreshed.ready(),services);
 assert.equal(restored.render().unit.paragraphs.length,2);restored.hooks.unmount();refreshed.hooks.unmount();
});

test('explicit initialPaper wins over a recent different material',async()=>{
 reset();const services=scope(),a=material('Explicit A'),b=material('Recent B');
 await savePaperMaterial(services.owner,services.library,a);await savePaperMaterial(services.owner,services.library,b);
 const prior=hook(services);await prior.ready();await prior.render().choose(b);prior.hooks.unmount();
 const explicit=hook(services,a);assert.equal((await explicit.ready()).paper.title,a.title);explicit.hooks.unmount();
});

test('legacy drafts without a bookmark retain the existing latest-material and stored-position fallback',async()=>{
 reset();const services=scope(),paper=material('Legacy');await savePaperMaterial(services.owner,services.library,paper);
 const draft=await openPaperDraft(services.owner,services.library,paper);await draft.flush();await draft.update(value=>({...value,position:1,summaries:{p1:'Original saved summary.'}}));await draft.flush();
 const loaded=hook(services),view=reader(await loaded.ready(),services);
 assert.equal(view.render().unit.position,1);assert.equal(view.render().unit.paragraphs.length,1);
 assert.equal(loaded.render().session.snapshot().draft.summaries.p1,'Original saved summary.');view.hooks.unmount();loaded.hooks.unmount();
});

test('a delayed initial material read cannot overwrite a newer explicit material choice',async()=>{
 reset();const services=scope(),a=material('Chosen A'),b=material('Late B'),gate=deferred();
 await savePaperMaterial(services.owner,services.library,a);await savePaperMaterial(services.owner,services.library,b);
 const loaded=hook(services,undefined,{'app/paper-draft-store.ts':{paperFingerprint,openPaperDraft,savePaperMaterial,loadPaperMaterials:()=>gate.promise}});
 await loaded.render().choose(a);assert.equal(loaded.render().paper.title,a.title);gate.resolve([{fingerprint:await paperFingerprint(b),paper:b}]);
 await tick();loaded.render();await tick();assert.equal(loaded.render().paper.title,a.title);loaded.hooks.unmount();
});

test('rebinding one hook to another owner and library hides old materials immediately and never flushes the retired draft',async()=>{
 reset();const firstScope=scope(),secondScope={owner:'audit:new-owner',library:'audit:new-library'},a=material('Private synthetic A'),b=material('Other synthetic B');
 await savePaperMaterial(firstScope.owner,firstScope.library,a);await savePaperMaterial(secondScope.owner,secondScope.library,b);
 const opened=[];
 const loaded=hook(firstScope,undefined,{'app/paper-draft-store.ts':{paperFingerprint,savePaperMaterial,loadPaperMaterials,openPaperDraft:async(...args)=>{
  const session=await openPaperDraft(...args),wrapper={...session,kind:session.kind,snapshot:session.snapshot,subscribe:session.subscribe,flush:async()=>{opened.push(args[0]);return session.flush();}};return wrapper;
 }}});
 await loaded.ready();opened.length=0;
 assert.deepEqual(loaded.rebind(secondScope).materials,[]);await loaded.render().choose(b);
 assert.equal(loaded.render().paper.title,b.title);assert.equal(opened.includes(firstScope.owner),false);
 await loaded.ready();assert.deepEqual(loaded.render().materials.map(row=>row.paper.title),[b.title]);loaded.hooks.unmount();
});

test('bookmark writes isolate owner and library, and stale version or range metadata uses the legacy fallback',async()=>{
 reset();const services=scope(),bound={ownerId:services.owner,libraryId:services.library},paper=material('Bound'),fingerprint=await paperFingerprint(paper);
 const entry={materialFingerprint:fingerprint,sourceVersion:fingerprint,position:0,count:2};await savePaperReadingBookmark(bound,entry);
 assert.equal(await loadPaperReadingBookmarks({...bound,ownerId:'audit:other-owner'}),null);
 assert.equal(await loadPaperReadingBookmarks({...bound,libraryId:'audit:other-library'}),null);
 const saved=await loadPaperReadingBookmarks(bound);assert.equal(paperReadingBookmarkFor(saved,paper,fingerprint).count,2);
 assert.equal(paperReadingBookmarkFor(saved,{...paper,origin:{kind:'upload',version:'b'.repeat(64)}},fingerprint),null);
 await savePaperMaterial(services.owner,services.library,paper);
 await savePaperReadingBookmark(bound,{...entry,position:99});const invalid=hook(services);
 assert.equal((await invalid.ready()).bookmark.count,1);assert.equal(invalid.render().bookmark.position,0);invalid.hooks.unmount();
 await saveWorkspaceRecord(bound.ownerId,`paper-reading-bookmark:v1:${bound.libraryId}`,{...saved,schemaVersion:999});
 const unknown=hook(services);assert.equal((await unknown.ready()).bookmark.count,1);unknown.hooks.unmount();
});

test('retiring a scope before the sidecar transaction writes leaves no late bookmark',async()=>{
 reset();const services=scope(),bound={ownerId:services.owner,libraryId:services.library},fingerprint=await paperFingerprint(material('Cancelled'));
 let active=true;const pending=savePaperReadingBookmark(bound,{materialFingerprint:fingerprint,sourceVersion:fingerprint,position:0,count:2},()=>active);
 active=false;await assert.rejects(pending,/选择已变化/);assert.equal(await loadPaperReadingBookmarks(bound),null);
});

test('a failed pointer save keeps the visible material and existing draft unchanged',async()=>{
 reset();const services=scope(),a=material('Failure A'),b=material('Failure B');
 await savePaperMaterial(services.owner,services.library,a);await savePaperMaterial(services.owner,services.library,b);
 const draft=await openPaperDraft(services.owner,services.library,b);await draft.flush();await draft.update(value=>({...value,summaries:{p1:'Keep the original summary.'}}));await draft.flush();
 const loaded=hook(services,undefined,{'app/paper-reading/bookmark.ts':{loadPaperReadingBookmarks,paperReadingBookmarkFor,savePaperReadingBookmark:async()=>{throw Error('synthetic quota failure');}}});
 await loaded.ready();await assert.rejects(loaded.render().choose(a),/quota/);assert.equal(loaded.render().paper.title,b.title);
 await assert.rejects(loaded.render().add(a),/quota/);assert.equal(loaded.render().paper.title,b.title);
 assert.equal(loaded.render().session.snapshot().draft.summaries.p1,'Keep the original summary.');
 assert.equal(await loadPaperReadingBookmarks({ownerId:services.owner,libraryId:services.library}),null);loaded.hooks.unmount();
});

test('a failed range pointer is reported, leaves the original range, and can be retried',async()=>{
 reset();const services=scope(),paper=material('Range failure');await savePaperMaterial(services.owner,services.library,paper);
 const loaded=hook(services),model=await loaded.ready();let fail=true;
 const view=reader({...model,remember:async value=>{if(fail)throw Error('synthetic quota');return model.remember(value);}},services);
 view.render().onCount(2);await waitForObservation(async()=>{await tick();view.render();},()=>text(view.hooks.view()).includes('阅读范围尚未保存'));
 assert.equal(view.render().unit.paragraphs.length,1);fail=false;button(view.hooks.view(),'重试保存阅读位置').props.onClick();
 await waitForObservation(async()=>{await tick();view.render();},()=>view.render().unit.paragraphs.length===2);
 view.hooks.unmount();loaded.hooks.unmount();
});

test('question flush failure prevents any range pointer save or visible range change',async()=>{
 reset();const services=scope(),paper=material('Question failure');await savePaperMaterial(services.owner,services.library,paper);
 const loaded=hook(services),model=await loaded.ready();let writes=0;
 const view=reader({...model,remember:async()=>{writes++;}},services);
 view.render().task.props.onSession({snapshot:()=>({ready:false,workspace:null,error:'quota'}),subscribe:()=>()=>{},flush:async()=>{throw Error('quota');}});
 view.render().onCount(2);await tick();view.render();assert.equal(view.render().unit.paragraphs.length,1);assert.equal(writes,0);
 view.hooks.unmount();loaded.hooks.unmount();
});

test('a range flush that completes after reader disposal cannot write a late pointer',async()=>{
 reset();const services=scope(),paper=material('Retired range'),gate=deferred();await savePaperMaterial(services.owner,services.library,paper);
 const loaded=hook(services),view=reader(await loaded.ready(),services);
 view.render().task.props.onSession({snapshot:()=>({ready:false,workspace:null,error:''}),subscribe:()=>()=>{},flush:()=>gate.promise});
 view.render().onCount(2);view.hooks.unmount();gate.resolve();await tick();await tick();
 assert.equal(await loadPaperReadingBookmarks({ownerId:services.owner,libraryId:services.library}),null);loaded.hooks.unmount();
});

test('an active-unit sidecar write protects navigation and beforeunload until the durable receipt resolves',async()=>{
 reset();const services=scope(),paper=material('Active receipt'),gate=deferred();await savePaperMaterial(services.owner,services.library,paper);
 const loaded=hook(services),model=await loaded.ready(),view=reader({...model,remember:()=>gate.promise},services);
 const source={ownerId:services.owner,libraryId:services.library,sectionId:'s',paragraphs:[{id:'p1',rawEn:paper.sections[0].paragraphs[0].rawEn}]};
 view.render().task.props.onSession({snapshot:()=>({ready:true,saving:false,error:'',workspace:{unit:{unitId:'audit:active-pending',source}}}),subscribe:()=>()=>{},flush:async()=>{}});
 await tick();assert.equal(view.render().saving,true);assert.match(view.guards.at(-1).message(),/阅读位置尚未保存/);
 let prevented=false;view.events.get('beforeunload')({preventDefault(){prevented=true;},returnValue:undefined});assert.equal(prevented,true);
 gate.resolve();await tick();assert.equal(view.render().saving,false);assert.equal(view.guards.at(-1).message(),null);
 view.hooks.unmount();loaded.hooks.unmount();
});

test('the saved active unit and multi-paragraph original answer restore together before a reader is rendered',async()=>{
 reset();const services=scope(),bound={ownerId:services.owner,libraryId:services.library},paper=material('Active unit');await savePaperMaterial(services.owner,services.library,paper);
 const fingerprint=await paperFingerprint(paper),source={...bound,materialFingerprint:fingerprint,sourceVersion:fingerprint,sectionId:'s',paragraphs:paper.sections[0].paragraphs.slice(0,2).map(({id,rawEn})=>({id,rawEn}))};
 const unit={schemaVersion:1,unitId:'audit:prepared-original-unit',title:paper.title,goal:'Explain the original synthetic mechanism',source};
 const readingSession=createPaperReadingSession({unit,store:createPaperReadingStore(),makeId:()=>crypto.randomUUID(),now:()=>new Date('2026-10-25T06:00:00Z')});
 await readingSession.load();await readingSession.begin(paperReadingTask({taskId:'audit:prepared-question',revision:1,source,goal:unit.goal,origin:'prepared',ability:'mechanism',question:'What does this synthetic material describe?',reference:[{point:'It describes an imaginary task.',paragraphId:'p1',quote:source.paragraphs[0].rawEn}]}));
 await readingSession.answer('An original synthetic saved answer.');await readingSession.flush();
 const first=hook(services),model=await first.ready();await model.remember({position:0,count:2});
 const view=reader({...model,bookmark:{...model.bookmark,count:2}},services);view.render().task.props.onSession(readingSession);
 let saved;await waitForObservation(async()=>{await tick();saved=await loadPaperReadingBookmarks(bound);},()=>Boolean(saved?.entries[0].activeUnitId));
 view.hooks.unmount();first.hooks.unmount();
 const refreshed=hook(services),restored=await refreshed.ready();
 assert.equal(restored.bookmark.count,2);assert.equal(restored.resume.workspace.unit.unitId,unit.unitId);
 assert.equal(restored.resume.workspace.answer,'An original synthetic saved answer.');
 const freshReader=reader(restored,services);assert.equal(freshReader.render().unit.paragraphs.length,2);
 freshReader.hooks.unmount();refreshed.hooks.unmount();readingSession.dispose();
});
