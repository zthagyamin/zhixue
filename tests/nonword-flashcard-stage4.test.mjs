import test from 'node:test';
import assert from 'node:assert/strict';
import {createHooks,loader,nodes,text,tick} from './helpers/causal-harness.mjs';
import {flashcardAnswerView} from '../src/domain/flashcard-reading/index.ts';

function fixture({original={front:'为什么价格上限可能造成短缺？',back:'需求量超过供给量。',sourceNote:'经济学/供求.md#价格上限'},mode='flashcard',lifecycle=false,back=original.back,support}={}){
  const hooks=createHooks(),grades=[],candidates=[];
  function MathText(){return null;}
  function CandidateLauncher(props){candidates.push(props);return null;}
  const load=loader(hooks.api,{'app/math-text.tsx':{MathText},'app/study-guidance.tsx':{StudyGuidance:()=>null},
    'app/ai/use-report-study-ai-item.ts':{useReportStudyAIItem(){}},'app/assistance-display.tsx':{useAssistance:()=>null,useAssistanceDisplay(){}},
    'app/use-study-swipe.ts':{useStudySwipe:()=>({})},'src/features/remediation/index.ts':{CandidateLauncher}},
    {addEventListener(){},removeEventListener(){}});
  const data={itemId:'card-child',front:original.front??original.word,back,...(support?{learningSupport:support}:{})};
  const props={data,context:{contentSource:{mode,data:original},...(lifecycle?{nonWordLearning:{ready:true,purpose:'first'}}:{})},onGrade:rating=>grades.push(rating)};
  const shell=load('app/plugins/plugin-flashcard.tsx').FlashcardPlugin.renderUI(props);hooks.mount(shell.type,shell.props);hooks.flush();
  return{hooks,load,data,grades,CandidateLauncher,MathText,async reveal(){const b=[...nodes(hooks.view())].find(n=>n.type==='button'&&text(n).startsWith('显示答案'));assert.ok(b);b.props.onClick();hooks.render();hooks.flush();await tick();},candidate(){return [...nodes(hooks.view())].find(n=>n.type===CandidateLauncher);}};
}

test('the front shows this card source before reveal without exposing its answer',()=>{
  const f=fixture();assert.match(f.hooks.view().props.className,/study-flashcard--nonword/);const view=text(f.hooks.view());assert.match(view,/经济学\/供求.md/);assert.match(view,/价格上限/);
  assert.doesNotMatch(view,/需求量超过供给量/);assert.equal(f.grades.length,0);f.hooks.unmount();
});
test('missing per-card source is stated honestly before recall',()=>{
  const f=fixture({original:{front:'机制是什么？',back:'解释'}});assert.match(text(f.hooks.view()),/来源尚未定位/);f.hooks.unmount();
});
test('a source answer is visible first and its complete explanation can be opened without grading',async()=>{
  const original={front:'短缺是什么？',answer:'需求量超过供给量。',explanation:'当上限低于均衡价格，需求量增加而供给量减少。',back:'需求量超过供给量。\n\n当上限低于均衡价格，需求量增加而供给量减少。'};
  const f=fixture({original});await f.reveal();
  const answer=[...nodes(f.hooks.view())].find(n=>n.type?.name==='FlashcardAnswer');
  const view=answer?answer.type(answer.props):f.hooks.view();
  assert.ok([...nodes(view)].some(n=>n.type===f.MathText&&n.props.text===original.answer));
  const full=[...nodes(view)].find(n=>n.type==='details');assert.ok(full);assert.equal(full.props.open,undefined);
  assert.ok([...nodes(full)].some(n=>n.type===f.MathText&&n.props.text===original.back));assert.equal(f.grades.length,0);f.hooks.unmount();
});
test('a vocabulary item displayed as flashcard cannot use nonword splitting',async()=>{
  const f=fixture({mode:'three-stage',original:{word:'scarce',meaning:'稀缺的',front:'scarce',back:'稀缺的\n\n例句'},back:'稀缺的\n\n例句'});
  await f.reveal();assert.equal(f.candidate(),undefined);assert.doesNotMatch(f.hooks.view().props.className,/study-flashcard--nonword/);f.hooks.unmount();
});
test('original vocabulary fields still exclude splitting under a nominal recall mode',async()=>{
  const f=fixture({mode:'recall',original:{word:'scarce',front:'scarce',back:'稀缺的\n\n例句'}});await f.reveal();
  assert.equal(f.candidate(),undefined);assert.doesNotMatch(text(f.hooks.view()),/本卡来源|来源尚未定位/);f.hooks.unmount();
});
test('an eligible complex card reuses preview candidates with the active child identity and source version',async()=>{
  const original={front:'区分两个机制',back:'第一个机制。\n\n第二个机制。',contentHash:'source-v1'};
  const f=fixture({original,support:{schemaVersion:1,type:'flashcard',mode:'bidirectional',parentId:'card-group',direction:'reverse'}});
  await f.reveal();const candidate=f.candidate();assert.ok(candidate);assert.equal(candidate.props.source.key,'card-child');assert.equal(candidate.props.source.version,'source-v1');
  assert.equal(candidate.props.seeds.length,2);assert.equal(f.grades.length,0);assert.equal(original.back,'第一个机制。\n\n第二个机制。');f.hooks.unmount();
});
test('an occlusion child retains its image and target and offers no text splitting',async()=>{
  const support={schemaVersion:1,type:'flashcard',mode:'occlusion',parentId:'image-parent',sourceKey:'a'.repeat(64),sourceVersion:'b'.repeat(64),assetId:'diagram',assetVersion:'c'.repeat(64),activeMaskId:'m1',masks:[{id:'m1',x:'1',y:'1',width:'2',height:'2',answer:'目标'}]};
  const f=fixture({support});const image=[...nodes(f.hooks.view())].find(n=>n.props.support===support);assert.ok(image);assert.equal(image.props.revealed,false);assert.equal(f.candidate(),undefined);f.hooks.unmount();
});

test('an ordinary paragraph, formula and code back is never truncated into guessed key points',()=>{
  const back='第一个条件。\n\n第二个必要条件：$x > 0$。\n\n```python\nresult = x ** 2\n```';
  assert.deepEqual(flashcardAnswerView(back),{primary:back,full:back,compact:false});
});
test('explicit key points fold only full explanation and preserve the original bytes',()=>{
  const back='## 关键要点\r\n- 当需求量大于供给量时发生短缺。\r\n- 条件：价格低于均衡价格。\r\n\r\n## 完整说明\r\n$Q_d > Q_s$，并非所有价格上限都会造成短缺。';
  const view=flashcardAnswerView(back);assert.equal(view.compact,true);assert.equal(view.full,back);
  assert.equal(view.primary,'- 当需求量大于供给量时发生短缺。\r\n- 条件：价格低于均衡价格。');
});
test('an apparent explanation label inside code or math cannot hide its following contents',()=>{
  for(const marker of ['```python','~~~text','$$']){
    const back=`关键要点\n${marker}\n完整说明\n必须完整显示\n${marker}`;
    assert.equal(flashcardAnswerView(back).compact,false);assert.equal(flashcardAnswerView(back).primary,back);
  }
});
test('an unrelated original answer cannot substitute the active back',()=>{
  const back='当前答案。\n\n当前解释。',original={answer:'旧版答案。',explanation:'旧版解释。'};
  assert.equal(flashcardAnswerView(back,original).compact,false);assert.equal(flashcardAnswerView(back,original).primary,back);
});
test('simple cards have no disabled splitting tool in the normal recall path',async()=>{
  const f=fixture();await f.reveal();assert.equal(f.candidate(),undefined);assert.doesNotMatch(text(f.hooks.view()),/更多工具/);f.hooks.unmount();
});
test('splitting remains an optional collapsed tool and preserves the complete parent back',async()=>{
  const f=fixture({original:{front:'解释两个条件',back:'第一条件\n\n第二条件'}});await f.reveal();const candidate=f.candidate();assert.ok(candidate);
  const tools=[...nodes(f.hooks.view())].find(n=>n.type==='details'&&text(n).includes('更多工具'));assert.ok(tools);assert.equal(tools.props.open,undefined);
  assert.equal(candidate.props.source.fragments[0].text,f.data.back);assert.equal(f.grades.length,0);f.hooks.unmount();
});
test('a reverse child never borrows the original forward answer as its key points',async()=>{
  const original={front:'正面',answer:'原正向答案',explanation:'原正向解释',back:'原正向答案\n\n原正向解释'};
  const support={schemaVersion:1,type:'flashcard',mode:'bidirectional',parentId:'parent',direction:'reverse'};
  const f=fixture({original,support});await f.reveal();assert.equal([...nodes(f.hooks.view())].some(n=>n.type?.name==='FlashcardAnswer'),false);
  assert.ok([...nodes(f.hooks.view())].some(n=>n.type===f.MathText&&n.props.text===original.back));f.hooks.unmount();
});

test('nonword code back uses the shared literal code renderer without grading or removing source text',async()=>{
 const back='先解释条件。\n\n```python\nresult = x ** 2\n```\n\n再说明限制。';
 const f=fixture({original:{front:'解释计算过程',back}});await f.reveal();
 const code=[...nodes(f.hooks.view())].find(node=>node.type==='pre');assert.ok(code);assert.match(text(code),/result = x \*\* 2/);
 const prose=[...nodes(f.hooks.view())].filter(node=>node.type===f.MathText).map(node=>node.props.text).join('');assert.match(prose,/先解释条件/);assert.match(prose,/再说明限制/);assert.equal(f.grades.length,0);f.hooks.unmount();
});
