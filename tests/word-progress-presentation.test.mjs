import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {dashboardValue} from './fixtures/dashboard-functions.mjs';
import {loadTsx} from './fixtures/tsx-components.mjs';

let presentation={};
try{presentation={...await import('../src/features/study-word-progress/presentation.ts'),...loadTsx(new URL('../src/features/study-word-progress/word-study-queue.tsx',import.meta.url))};}
catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}

const source=readFileSync(new URL('../app/study-dashboard/subject-view.tsx',import.meta.url),'utf8');
const ast=ts.createSourceFile('subject-view.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function shellProp(name,env){
  let expression;
  function visit(node){
    if(ts.isJsxOpeningElement(node)&&node.tagName.getText(ast)==='StudySessionShell'){
      const prop=node.attributes.properties.find(value=>ts.isJsxAttribute(value)&&value.name.getText(ast)===name);
      if(prop?.initializer&&ts.isJsxExpression(prop.initializer))expression=prop.initializer.expression.getText(ast);
    }
    ts.forEachChild(node,visit);
  }
  visit(ast);assert.ok(expression,`StudySessionShell.${name} exists`);
  const compiled=ts.transpileModule(`return (${expression});`,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,jsx:ts.JsxEmit.React}}).outputText;
  return new Function(...Object.keys(env),compiled)(...Object.values(env));
}
function view(overrides={}){
  const env={isDemoMode:false,taskScope:null,scopedTask:undefined,isDueWordReview:false,isVocabPaced:true,vocabServedGroup:0,vocabBounds:[{},{}],items:Array.from({length:20},(_,index)=>({word:`word-${index}`})),accountLoaded:null,scopedAccountProgress:null,recallPassUsed:false,actualPluginType:'three-stage',practiced:[],vocabServedCompletedCount:1,round:{correctKeys:[]},currentStage:1,quickReview:false,pluginLabels:{'three-stage':'三阶段背词',recall:'回忆'},...presentation,...overrides};
  if(presentation.wordStudyPresentation)env.wordPresentation=dashboardValue('wordPresentation',env);
  return {env,scope:shellProp('scope',env),progress:shellProp('progress',env),mode:shellProp('mode',env)};
}

test('actual vocabulary shell labels group, existing completion and current step separately',()=>{
  const current=view();
  assert.equal(current.scope,'自由学习 · 词库第 1 / 2 组');
  assert.equal(current.progress,'本组完成 1 / 20 词');
  assert.equal(current.mode,'当前步骤：认义');
  assert.doesNotMatch(current.progress,/本次已学/);
});

test('a partial final group uses the actual item count rather than the daily quota',()=>{
  const current=view({vocabServedGroup:1,items:Array.from({length:14},()=>({word:'tail'})),vocabServedCompletedCount:8});
  assert.equal(current.scope,'自由学习 · 词库第 2 / 2 组');
  assert.equal(current.progress,'本组完成 8 / 14 词');
});

test('a quick due-word probe has no fabricated three-step progress label',()=>{
  const current=view({taskScope:{},scopedTask:{category:'review'},isDueWordReview:true,quickReview:true,currentStage:3,vocabServedCompletedCount:0});
  assert.equal(current.scope,'到期复习 · 本组 20 词');
  assert.equal(current.mode,'到期复习 · 回忆核对');
  assert.doesNotMatch(current.mode,/3\/3|当前步骤/);
  assert.equal(view({currentStage:2}).mode,'当前步骤：语境');
  assert.equal(view({currentStage:3}).mode,'当前步骤：闭卷自评');
});

test('unverified account history remains unknown and a manual recall mode keeps practiced counts',()=>{
  assert.equal(view({accountLoaded:{},scopedAccountProgress:{historyReady:false}}).progress,'进度待核对');
  assert.equal(view({actualPluginType:'recall',practiced:['a','b'],vocabServedCompletedCount:9}).progress,'本组已练 2 / 20 词');
});

test('non-word sessions retain their original units, review scope and practiced counters',()=>{
  const current=view({isVocabPaced:false,taskScope:{},scopedTask:{category:'review'},actualPluginType:'recall',practiced:['a','b']});
  assert.equal(current.scope,'到期复习 · 本组 20 题');
  assert.equal(current.progress,'已练 2 / 20');
  assert.equal(current.mode,'回忆');
});

test('actual queue gives each word readable status and does not claim all three steps for a completed review',()=>{
  const {env}=view({items:[{word:'new'},{word:'meaning'},{word:'context'},{word:'done'}]});
  const queue=shellProp('queue',{...env,React:{createElement},uiProgress:{},subject:{pluginType:'three-stage'},idx:0,learningStages:{new:0,meaning:1,context:2,done:3},resolveStudyItemProgressKey:item=>item.word,itemLabel:item=>item.word,selectQuestion:()=>{throw Error('render must not select a word');}});
  const html=renderToStaticMarkup(queue);
  for(const label of ['未完成','待语境核对','待闭卷自评','本组已完成'])assert.ok(html.includes(label),label);
  assert.doesNotMatch(html,/三个阶段已完成|长期掌握/);
});

test('queue history must be verified before assigning per-word completion labels',()=>{
  assert.equal(typeof presentation.wordQueueStatus,'function');
  for(const stage of [0,1,2,3])assert.equal(presentation.wordQueueStatus(stage,false),'进度待核对');
});

test('presentation leaves input counts and persisted learning stages untouched across rerenders',()=>{
  assert.equal(typeof presentation.wordStudyPresentation,'function');
  const input=Object.freeze({demo:false,planned:false,review:false,groupIndex:0,groupCount:2,total:20,completed:1,ready:true,practiced:false,stage:1,quickReview:false,threeStage:true,modeLabel:'三阶段背词'});
  const first=presentation.wordStudyPresentation(input),second=presentation.wordStudyPresentation(input);
  assert.deepEqual(first,second);assert.equal(input.completed,1);assert.equal(input.stage,1);
});
