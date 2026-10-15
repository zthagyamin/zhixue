import test from 'node:test';
import assert from 'node:assert/strict';
import {createHooks,extract,deferred,tick,nodes} from './helpers/causal-harness.mjs';
import {createPaperReadingUnit} from '../src/domain/paper-reading/unit.ts';
import {IDBFactory} from 'fake-indexeddb';
import {createPaperOriginalCache} from '../app/paper-reading/original-cache.ts';
import {createHash} from 'node:crypto';

function fixture(options={}){
 const hooks=createHooks(),gate=deferred();
 const paper={paperId:'reading',title:'Reading',origin:options.origin,sections:[{id:'s',title:'Methods',paragraphs:[1,2,3].map(n=>({id:'p'+n,rawEn:'Paragraph '+n,pageNumber:n}))}]};
 let state={ready:true,saving:false,error:'',draft:{position:0}};
 const session={subscribe:()=>()=>{},snapshot:()=>state,update:async change=>{state={...state,saving:true,draft:change(state.draft)};await gate.promise;state={...state,saving:false};},flush:async()=>{await gate.promise;if(state.error)throw Error(state.error);}};
 const jsx=(type,props)=>({type,props});
 const component=extract('app/paper-reading/entry.tsx','ReadingDocument')({
  ...hooks.api,usePaperClock:()=>({controls:null,details:null,flush:async()=>{}}),createPaperReadingUnit,PaperReadingPage:'Page',PaperOriginalPage:'Original',PaperQuestionEntry:'Question',ReadingBackupControls:'Backup',PaperSourceText:'Text',MathText:'Math',
  createPaperOriginalCache:options.cache??createPaperOriginalCache,verifiedPaperScope:()=>{},confirmStudyNavigation:()=>true,
  registerStudyNavigationGuard:()=>()=>{},window:{addEventListener(){},removeEventListener(){}},
  document:{activeElement:null},HTMLButtonElement:class {},
  exports:{},require:()=>({jsx,jsxs:jsx}),
 });
 let props={paper,session,services:{owner:'u',library:'l'},sources:null};
 const render=(services)=>{if(services)props={...props,services};hooks.render(props);hooks.flush();return hooks.render().props;};
 hooks.mount(component,props);hooks.flush();
 return {hooks,render,gate,paper,setState:next=>{state={...state,...next};},getState:()=>state};
}

test('ordinary draft saves retain a selected multi-paragraph reading unit',async()=>{
 const f=fixture();f.render().onCount(2);await tick();assert.equal(f.render().unit.paragraphs.length,2);
 f.setState({saving:true});f.render();f.setState({saving:false});
 assert.equal(f.render().unit.paragraphs.length,2);
});

test('position advances only after reliable acknowledgement and resets the range',async()=>{
 const f=fixture();f.render().onCount(2);f.render().onPosition(2);await tick();
 assert.equal(f.render().unit.position,0);
 f.gate.resolve();await tick();assert.equal(f.render().unit.position,2);assert.equal(f.render().unit.paragraphs.length,1);
});

test('failed position saving keeps the current original and exposes failure',async()=>{
 const f=fixture();f.render().onPosition(1);await tick();
 f.setState({error:'quota exceeded'});f.gate.resolve();await tick();
 assert.equal(f.render().unit.position,0);assert.match(f.render().error,/quota exceeded/);
});
test('question save failure blocks navigation but a later reliable save removes the obsolete block',()=>{
 const f=fixture();f.render().task.props.onError('quota');assert.equal(f.render().navigationBlocked,true);assert.equal(f.render().toolsBlocked,true);
 f.render().task.props.onError('');assert.equal(f.render().navigationBlocked,false);assert.equal(f.render().toolsBlocked,false);
});

const uploaded=bytes=>({kind:'upload',path:'paper.pdf',version:createHash('sha256').update(bytes).digest('hex')});
const original=f=>[...nodes(f.render().original)].find(node=>node.type==='Original').props;
const provide=(f,file)=>[...nodes(f.render().original)].find(node=>node.type==='input').props.onChange({currentTarget:{files:[file],value:'chosen'}});

test('new isCurrent callbacks alone do not restart the original-page loader',()=>{
 const f=fixture({origin:uploaded(new Uint8Array([1]))});f.render().onOriginal();const load=original(f).load;
 f.render({owner:'u',library:'l',isCurrent:()=>true});assert.equal(original(f).load,load);
});

test('a late cached original cannot reach a different library',async()=>{
 const read=deferred(),bytes=new Uint8Array([1]);
 const f=fixture({origin:uploaded(bytes),cache:()=>({read:()=>read.promise})});f.render().onOriginal();
 const pending=original(f).load(new AbortController().signal);
 f.render({owner:'u',library:'another'});read.resolve({bytes});
 await assert.rejects(pending,/取消/);
});

test('same-version replacement restores real cache without changing material or draft; wrong bytes are rejected',async()=>{
 globalThis.indexedDB=new IDBFactory();const bytes=new TextEncoder().encode('%PDF-controlled');
 const f=fixture({origin:uploaded(bytes)}),before=JSON.stringify(f.paper);f.render().onOriginal();
 provide(f,{name:'wrong.pdf',size:1,arrayBuffer:async()=>new Uint8Array([9]).buffer});await tick();await tick();
 assert.equal(await createPaperOriginalCache().read({ownerId:'u',libraryId:'l',sourceVersion:f.paper.origin.version}),null);
 assert.match([...nodes(f.render().original)].find(n=>n.props.role==='alert').props.children,/版本|指纹/);
 provide(f,{name:'paper.pdf',size:bytes.length,arrayBuffer:async()=>bytes.buffer});
 for(let n=0;n<15;n++){await tick();f.render();}
 assert.deepEqual((await createPaperOriginalCache().read({ownerId:'u',libraryId:'l',sourceVersion:f.paper.origin.version})).bytes,bytes);
 assert.equal(JSON.stringify(f.paper),before);assert.equal(f.getState().draft.position,0);
});
