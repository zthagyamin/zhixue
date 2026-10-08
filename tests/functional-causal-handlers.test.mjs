import test from 'node:test';import assert from 'node:assert/strict';
import {createHooks,loader,nodes,text,button,deferred,tick} from './helpers/causal-harness.mjs';
const A={itemId:'A',fingerprint:'a',questionType:'quiz',sourceLabel:'synthetic',prompt:'A',options:['a','b'],answer:0,explanation:'A explanation'};
const B={...A,itemId:'B',fingerprint:'b',prompt:'B'};
function fixture(){const hooks=createHooks(),window={confirm:()=>true,addEventListener(){},removeEventListener(){}};
 const load=loader(hooks.api,{'app/study-guidance.tsx':{StudyGuidanceHelp:()=>null},'app/study-item-source.tsx':{StudyItemSource:()=>null},'app/review-context.tsx':{ReviewContext:()=>null},'app/plugins/index.ts':{registry:{get:()=>({renderUI:()=>null})}},'app/math-text.tsx':{MathText:()=>null}},window);
 return {hooks,window,load,Practice:load('app/practice-session.tsx').PracticeSession,store:load('app/learning-draft-store.ts').createLearningDraftStore('synthetic')};
}
const plugin=root=>[...nodes(root)].find(node=>typeof node.props.onGrade==='function'&&node.props.data);
test('immediate reordered review never saves a second event or upgrades the first-result summary',async()=>{
 const f=fixture(),records=[],finished=[];
 const client={variantPractice:async source=>({item:{...source,options:['b','a'],answer:1}})};
 f.hooks.mount(f.Practice,{items:[A],companionClient:client,drafts:f.store,onRecordAttempt:async row=>records.push(row.rating),onFinish:value=>finished.push(value)});
 await settle(f);await plugin(f.hooks.view()).props.onGrade('again');f.hooks.render();
 button(f.hooks.view(),'重排复习').props.onClick();await settle(f);
 assert.match(text(f.hooks.view()),/即时重练.*不计入正式记录/);
 assert.equal(plugin(f.hooks.view()).props.context.recallPersistenceRequired,false);
 await plugin(f.hooks.view()).props.onGrade('good');await settle(f);
 assert.deepEqual(records,['again']);assert.deepEqual(finished,[{answered:1,correct:0,wrong:1}]);
});
test('an old companion changing a calculation answer is rejected without losing the original feedback',async()=>{
 const f=fixture(),records=[],calc={...A,questionType:'calculation',answer:'4'};
 const client={variantPractice:async source=>({item:{...source,prompt:'A（数值 ×2）',answer:'8'}})};
 f.hooks.mount(f.Practice,{items:[calc],companionClient:client,drafts:f.store,onRecordAttempt:async row=>records.push(row.rating)});
 await settle(f);await plugin(f.hooks.view()).props.onGrade('again');f.hooks.render();
 button(f.hooks.view(),'原题再练').props.onClick();await settle(f);
 assert.equal(plugin(f.hooks.view()).props.data.answer,'4');assert.equal(plugin(f.hooks.view()).props.data.prompt,'A');
 assert.deepEqual(records,['again']);assert.match(text(f.hooks.view()),/不受支持的题目改动/);
});
test('a pending original retry cannot discard temporary input entered while it was preparing',async()=>{
 const f=fixture(),wait=deferred();
 f.hooks.mount(f.Practice,{items:[A],companionClient:{variantPractice:()=>wait.promise},drafts:f.store});
 await settle(f);await plugin(f.hooks.view()).props.onGrade('again');f.hooks.render();
 button(f.hooks.view(),'重排复习').props.onClick();f.hooks.render();
 const child=plugin(f.hooks.view()).props.context.draft.createTemporary({answer:''});child.write('answer','new temporary work');
 wait.resolve({item:{...A,options:['b','a'],answer:1}});await settle(f);
 assert.equal(child.isActive(),true);assert.equal(child.read('answer'),'new temporary work');
 assert.match(text(f.hooks.view()),/未确认的临时输入/);
});
test('parent-provided items preserve B, its draft and summary through transport refresh or disconnect',async()=>{
 const f=fixture(),items=[A,B],finished=[],records=[];
 const props={items,companionClient:{},drafts:f.store,onRecordAttempt:async value=>records.push(value.item.itemId),onFinish:value=>finished.push(value)};
 f.hooks.mount(f.Practice,props);await settle(f);await plugin(f.hooks.view()).props.onGrade('good');f.hooks.render();
 plugin(f.hooks.view()).props.context.draft.write('answer','B draft');
 for(const companionClient of [{},null]){f.hooks.render({...props,companionClient});await settle(f);assert.equal(plugin(f.hooks.view()).props.data.prompt,'B');assert.equal(plugin(f.hooks.view()).props.context.draft.read('answer',''),'B draft');}
 await plugin(f.hooks.view()).props.onGrade('good');assert.deepEqual(records,['A','B']);assert.deepEqual(finished,[{answered:2,correct:2,wrong:0}]);
});
test('refreshing transport invalidates its pending variant without resetting the provided session',async()=>{
 const f=fixture(),items=[A,B],wait=deferred();const props={items,companionClient:{variantPractice:()=>wait.promise},drafts:f.store};
 f.hooks.mount(f.Practice,props);await settle(f);await plugin(f.hooks.view()).props.onGrade('again');f.hooks.render();button(f.hooks.view(),'重排复习').props.onClick();
 f.hooks.render({...props,companionClient:null});await settle(f);wait.resolve({item:{...A,itemId:'late',prompt:'late variant'}});await settle(f);
 assert.equal(plugin(f.hooks.view()).props.data.prompt,'A');assert.ok(button(f.hooks.view(),'下次再考'));assert.doesNotMatch(text(f.hooks.view()),/正在准备原题复习|late variant/);
});
async function settle(f){f.hooks.flush();await tick();f.hooks.render();f.hooks.flush();await tick();f.hooks.render();}
test('FUN-06 actual component exits the error state after successful retry',async()=>{const f=fixture();let calls=0;f.hooks.mount(f.Practice,{items:null,companionClient:{getPractice:async()=>{if(++calls===1)throw Error('first failed');return{items:[A,B]};}},drafts:f.store});await settle(f);assert.ok(button(f.hooks.view(),'重试'));button(f.hooks.view(),'重试').props.onClick();f.hooks.render();await settle(f);assert.equal(calls,2);assert.equal(plugin(f.hooks.view()).props.data.prompt,'A');assert.doesNotMatch(text(f.hooks.view()),/first failed/);});
test('FUN-06 successful empty retry renders empty state rather than the old error',async()=>{const f=fixture();let calls=0;f.hooks.mount(f.Practice,{items:null,companionClient:{getPractice:async()=>{if(++calls===1)throw Error('first failed');return{items:[]};}},drafts:f.store});await settle(f);button(f.hooks.view(),'重试').props.onClick();f.hooks.render();await settle(f);assert.doesNotMatch(text(f.hooks.view()),/first failed/);assert.equal(plugin(f.hooks.view()),undefined);});
test('FUN-02 duplicate variant requests are ignored and A cannot replace B after skip',async()=>{const f=fixture(),requests=[],records=[],finished=[];const client={variantPractice:()=>{const d=deferred();requests.push(d);return d.promise;}};f.hooks.mount(f.Practice,{items:[A,B],companionClient:client,drafts:f.store,onRecordAttempt:async p=>records.push(p.item.itemId),onFinish:s=>finished.push(s)});await settle(f);await plugin(f.hooks.view()).props.onGrade('again');f.hooks.render();const start=button(f.hooks.view(),'重排复习').props.onClick;start();start();assert.equal(requests.length,1);f.hooks.render();assert.ok(button(f.hooks.view(),'正在准备原题复习…').props.disabled);button(f.hooks.view(),'下次再考').props.onClick();f.hooks.render();assert.equal(plugin(f.hooks.view()).props.data.prompt,'B');const draft=plugin(f.hooks.view()).props.context.draft;draft.write('answer','keep B');requests[0].resolve({item:{...A,itemId:'variant-A',prompt:'variant-A'}});await settle(f);assert.equal(plugin(f.hooks.view()).props.data.prompt,'B');assert.equal(draft.read('answer',''),'keep B');await plugin(f.hooks.view()).props.onGrade('good');assert.deepEqual(records,['A','B']);assert.equal(finished.length,1);});
test('FUN-02 ending a session invalidates late variant success and failure',async()=>{for(const failure of [false,true]){const f=fixture(),wait=deferred(),finished=[];f.hooks.mount(f.Practice,{items:[A,B],companionClient:{variantPractice:()=>wait.promise},drafts:f.store,onFinish:s=>finished.push(s)});await settle(f);await plugin(f.hooks.view()).props.onGrade('again');f.hooks.render();button(f.hooks.view(),'重排复习').props.onClick();button(f.hooks.view(),'结束复习').props.onClick();if(failure)wait.reject(Error('late'));else wait.resolve({item:{...B,prompt:'late'}});await settle(f);assert.notEqual(plugin(f.hooks.view()).props.data.prompt,'late');assert.equal(finished.length,1);}});
test('existing save lock and retry keep official writes single and preserve the current question',async()=>{const f=fixture(),wait=deferred();let calls=0;f.hooks.mount(f.Practice,{items:[A,B],drafts:f.store,onRecordAttempt:async()=>{calls++;await wait.promise;}});await settle(f);const grade=plugin(f.hooks.view()).props.onGrade;const pending=grade('good');await grade('good');assert.equal(calls,1);wait.reject(Error('disk'));await pending;f.hooks.render();assert.equal(plugin(f.hooks.view()).props.data.prompt,'A');assert.match(text(f.hooks.view()),/尚未保存/);assert.equal(f.store.isPending(),false);});
test('calculation saves once then advances only through the committed continuation',async()=>{const f=fixture();let writes=0,done=0;const calc={...A,questionType:'calculation',answer:'2'};f.hooks.mount(f.Practice,{items:[calc],drafts:f.store,onRecordAttempt:async()=>{writes++;},onFinish:()=>done++});await settle(f);await plugin(f.hooks.view()).props.onGrade('good',{deferAdvance:true});f.hooks.render();assert.equal(writes,1);assert.equal(done,0);const draft=plugin(f.hooks.view()).props.context.draft;draft.continueAfterFeedback();draft.continueAfterFeedback();assert.equal(writes,1);assert.equal(done,1);});
test('FUN-08 IME confirmation does not call tutor, ordinary Enter still sends once',async()=>{const f=fixture(),Tutor=f.load('app/plugins/tutor-follow-up.tsx').TutorFollowUp,wait=deferred();let calls=0;f.hooks.mount(Tutor,{askTutor:async()=>{calls++;return wait.promise;},item:A,draft:f.store.adapter('A','v')});await settle(f);let input=[...nodes(f.hooks.view())].find(n=>n.type==='input');input.props.onChange({target:{value:'中文问题'}});f.hooks.render();input=[...nodes(f.hooks.view())].find(n=>n.type==='input');input.props.onCompositionStart();input.props.onKeyDown({key:'Enter',nativeEvent:{isComposing:false}});input.props.onCompositionEnd();input.props.onKeyDown({key:'Enter',nativeEvent:{isComposing:true}});input.props.onKeyDown({key:'Enter',nativeEvent:{keyCode:229}});assert.equal(calls,0);const event={key:'Enter',nativeEvent:{isComposing:false},preventDefault(){}};input.props.onKeyDown(event);input.props.onKeyDown(event);assert.equal(calls,1);wait.resolve('answer');await settle(f);});
test('FUN-05 actual coding question JSX preserves comparisons, generics and line breaks as inert text',async()=>{const f=fixture(),load=loader(f.hooks.api,{'app/study-guidance.tsx':{StudyGuidance:()=>null},'app/ai/use-report-study-ai-item.ts':{useReportStudyAIItem:()=>{}},'app/components/code-editor.tsx':{CodeEditor:()=>null},'app/hooks/use-pyodide.ts':{usePyodide:()=>({isReady:false,retry(){},cancel(){}})}},f.window);const Code=load('app/plugins/plugin-code.tsx').CodePlugin.renderUI;const prompt='如果 x < 0，返回 -1；如果 x > 0，返回 1。\nvector<int>\n<img src=x onerror=alert(1)>';f.hooks.mount(Code,{data:{prompt,initialCode:'',testCode:'assert True'},onGrade(){},context:{}});await settle(f);assert.ok([...nodes(f.hooks.view())].some(n=>n.type==='p'&&text(n)===prompt));assert.equal([...nodes(f.hooks.view())].filter(n=>n.type==='img').length,0);});
test('R-02 a saved-material switch invalidates pending file reads and preserves B',async()=>{
 const hooks=createHooks(),listeners=new Map(),window={confirm:()=>true,location:{hash:''},addEventListener:(k,f)=>listeners.set(k,f),removeEventListener:(k,f)=>{if(listeners.get(k)===f)listeners.delete(k);}};
 const load=loader(hooks.api,{'app/saved-trial-materials.tsx':{SavedTrialMaterials:()=>null}},window),Trial=load('app/note-trial.tsx').NoteTrial,wait=deferred();const f={hooks};
 hooks.mount(Trial,{owner:'account:a',library:'l',onConnect(){}});await settle(f);
 const file=[...nodes(hooks.view())].find(n=>n.type==='input'&&n.props.multiple);file.props.onChange({target:{files:[{name:'A.md',size:50,arrayBuffer:()=>wait.promise}],value:'A.md'}});hooks.render();hooks.flush();
 const open=listeners.get('zhixue:trial-material-open');global.requestAnimationFrame=fn=>fn();open({detail:{owner:'account:a',library:'l',questions:[{id:'B',prompt:'B',answer:'reference B',filename:'B.md',section:null,kind:'qa'}]}});hooks.render();hooks.flush();
 wait.resolve(new TextEncoder().encode('Q: A\nA: A reference').buffer);await settle(f);
 assert.ok([...nodes(hooks.view())].some(n=>n.type==='h3'&&text(n)==='B'));assert.doesNotMatch(text(hooks.view()),/正在本页读取/);hooks.unmount();delete global.requestAnimationFrame;
});
test('R-01 the actual trial registers a current-input guard, cancel preserves it, confirm invalidates pending work',async()=>{
 const hooks=createHooks(),listeners=new Map();let allowed=false;const window={confirm:()=>allowed,location:{hash:''},addEventListener:(k,f)=>listeners.set(k,f),removeEventListener:(k,f)=>{if(listeners.get(k)===f)listeners.delete(k);}};
 const load=loader(hooks.api,{'app/saved-trial-materials.tsx':{SavedTrialMaterials:()=>null}},window),Trial=load('app/note-trial.tsx').NoteTrial,guard=load('app/study-navigation-guard.ts');
 const f={hooks};hooks.mount(Trial,{owner:'account:a',library:'l',onConnect(){}});await settle(f);assert.equal(guard.confirmStudyNavigation(),true);
 const area=[...nodes(hooks.view())].find(n=>n.type==='textarea');area.props.onChange({target:{value:'我的未提交笔记'}});hooks.render();hooks.flush();assert.equal(guard.confirmStudyNavigation(),false);hooks.render();assert.equal([...nodes(hooks.view())].find(n=>n.type==='textarea').props.value,'我的未提交笔记');
 allowed=true;assert.equal(guard.confirmStudyNavigation(),true);hooks.unmount();assert.equal(guard.confirmStudyNavigation(()=>false),true);
});
test('a new pending file requires fresh navigation consent even when pasted text was already dirty',async()=>{
 const hooks=createHooks(),listeners=new Map(),window={confirm:()=>true,location:{hash:''},addEventListener:(key,fn)=>listeners.set(key,fn),removeEventListener:(key,fn)=>{if(listeners.get(key)===fn)listeners.delete(key);}};
 const load=loader(hooks.api,{'app/saved-trial-materials.tsx':{SavedTrialMaterials:()=>null}},window),Trial=load('app/note-trial.tsx').NoteTrial,guard=load('app/study-navigation-guard.ts');
 hooks.mount(Trial,{owner:'account:a',library:'l',onConnect(){}});const f={hooks};await settle(f);
 [...nodes(hooks.view())].find(n=>n.type==='textarea').props.onChange({target:{value:'already dirty'}});hooks.render();hooks.flush();
 let confirmations=0;const leave=guard.prepareStudyNavigation(()=>++confirmations===1);assert.ok(leave);
 const wait=deferred();[...nodes(hooks.view())].find(n=>n.type==='input'&&n.props.multiple).props.onChange({target:{files:[{name:'new.md',size:30,arrayBuffer:()=>wait.promise}],value:'new.md'}});hooks.render();hooks.flush();
 assert.equal(leave(),false);assert.equal(confirmations,2);assert.equal([...nodes(hooks.view())].find(n=>n.type==='textarea').props.value,'already dirty');
 wait.resolve(new TextEncoder().encode('Q: New material\nA: New answer').buffer);await settle(f);assert.ok([...nodes(hooks.view())].some(n=>n.type==='h3'&&text(n)==='New material'));hooks.unmount();
});
