import assert from 'node:assert/strict';
import test from 'node:test';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {buildRecallPrompt,recallPrompt,isRecallEcho} from '../app/recall-content.ts';
import {recallReference,recallChosenRating} from '../app/recall-flow-model.ts';

// Screenshot text is a regression fixture, not an endorsement of its scientific claims.
const point='区分论文显式声明（使用了哪些技术、观察到什么效果）与因果推断（各项技术各自贡献多少）；AlexNet 只声明组合有效，未做逐项消融证明因果';
const task='区分论文显式声明（使用了哪些技术、观察到什么效果）与因果推断（各项技术各自贡献多少）';
const legacy=Object.freeze({itemId:'synthetic-paper',fingerprint:'original-fingerprint',sourceLabel:'论文核心观点',prompt:'请闭卷解释：'+point,reviewPoint:point,answer:point,explanation:point});
const generic='阅读材料：复习记录（待补具体问题）';
const fixtures=[
  [point,'论文核心观点','阅读材料：论文核心观点（待补具体问题）'],
  ['区分 A（甲;乙）与 B；第二段是参考内容','比较','阅读材料：比较（待补具体问题）'],
  ['解释条件【甲；乙】；参考','条件','阅读材料：条件（待补具体问题）'],
  ['为什么需要对照？控制其他条件。','实验','阅读材料：实验（待补具体问题）'],
  ['什么是过拟合？','模型','阅读材料：模型（待补具体问题）'],
  ['区分甲与乙','比较','阅读材料：比较（待补具体问题）'],
  ['负值置零，正值保持不变。','ReLU','阅读材料：ReLU（待补具体问题）'],
  ['负值置零，正值保持不变','负值置零，正值保持不变',generic],
  ['结论内容','opaque:item-id',generic],
  ['证明了组合有效；尚不确定单项贡献。','实验','阅读材料：实验（待补具体问题）'],
  ['说明了现象；还不能归因。','证据','阅读材料：证据（待补具体问题）'],
  ['', '',generic],
];
for(const [reviewPoint,label,expected] of fixtures)test(`offline prompt: ${reviewPoint.slice(0,36)||'empty'}`,()=>{
  assert.equal(buildRecallPrompt(reviewPoint,label),expected);
});
test('generated objective is withheld while its original reference and identity stay intact',()=>{
  const before=JSON.stringify(legacy),prompt=recallPrompt(legacy);
  assert.equal(prompt,'阅读材料：论文核心观点（待补具体问题）');
  assert.ok(!prompt.includes('AlexNet 只声明组合有效'));
  assert.equal(recallReference(legacy),point);
  assert.equal(recallReference({...legacy,prompt}),point);
  assert.equal(JSON.stringify(legacy),before);
  assert.equal(recallChosenRating(true,'good',null),'again');
});
test('legacy variants, multiple points and reference-only old payloads are compatible',()=>{
  assert.equal(recallPrompt({...legacy,prompt:'换个角度回忆：'+legacy.prompt}),'换个角度回忆：'+recallPrompt(legacy));
  assert.equal(recallPrompt({...legacy,answer:point+'；另一项参考',explanation:point+'；另一项参考'}),recallPrompt(legacy));
  assert.equal(recallReference({...legacy,answer:point+'；另一项参考',explanation:point+'；另一项参考'}),point+'；另一项参考');
  assert.equal(recallPrompt({prompt:legacy.prompt,explanation:point}),recallPrompt({...legacy,sourceLabel:undefined}));
});
test('authored prompts with an independent explanation are not rewritten',()=>{
  const data={prompt:'请闭卷解释：归纳偏置',reviewPoint:'归纳偏置',answer:'模型对解空间的偏好。',explanation:'用于约束可学习函数的假设。'};
  assert.equal(recallPrompt(data),data.prompt);
  assert.equal(recallReference(data),data.explanation);
});
test('echoing explanation falls through to an actual supplied answer',()=>{
  const prompt='为什么需要对照实验？';
  assert.equal(recallReference({prompt,explanation:prompt,reviewPoint:prompt,answer:'控制其他条件以比较目标因素。'}),'控制其他条件以比较目标因素。');
});
test('question-only content must not masquerade as a reference',()=>{
  const prompt='为什么需要对照实验？';
  assert.equal(recallReference({prompt,explanation:prompt,reviewPoint:prompt,answer:prompt},[{text:prompt},{text:prompt}],prompt),null);
  const taskOnly={prompt:'请闭卷解释：区分甲与乙',reviewPoint:'区分甲与乙',answer:'区分甲与乙',explanation:'区分甲与乙'};
  assert.equal(recallReference(taskOnly),null);
});
test('rubric candidates are filtered individually; genuine full hints still work',()=>{
  const prompt='请解释条件。';
  assert.equal(recallReference({prompt,explanation:prompt},[{text:prompt},{text:'需要独立同分布。'}],prompt),'需要独立同分布。');
  assert.equal(recallReference({prompt,explanation:prompt},[],'需要明确采样前提。'),'需要明确采样前提。');
});
test('zero, real explanations and mathematical distinctions are preserved',()=>{
  assert.equal(recallReference({prompt:'结果是多少？',answer:0}),'0');
  assert.equal(recallReference({prompt:'x²',answer:'x2'}),'x2');
  assert.equal(recallReference({prompt:'x+1',answer:'x-1'}),'x-1');
  assert.equal(recallReference({prompt:'X',answer:'x'}),'x');
  assert.equal(recallReference({prompt:'为什么？',explanation:'为什么？因为存在约束。'}),'为什么？因为存在约束。');
  assert.equal(recallReference({}),null);
});
test('echo comparison removes known wrappers, labels and trailing punctuation only',()=>{
  assert.equal(isRecallEcho('参考答案：区分甲与乙。','换个角度回忆：请闭卷回答：区分甲与乙'),true);
  assert.equal(isRecallEcho('x>0','x<0'),false);
  assert.equal(isRecallEcho('x²','x2'),false);
  assert.equal(isRecallEcho('',''),false);
});
function python(script,input){
  const result=spawnSync(process.env.PYTHON||'python',['-I','-X','utf8','-c',script,fileURLToPath(new URL('../companion/',import.meta.url))],{
    input:JSON.stringify(input),encoding:'utf8',timeout:30000,env:{...process.env,PYTHONUTF8:'1'},
  });
  assert.ifError(result.error);assert.equal(result.status,0,result.stderr);
  return JSON.parse(result.stdout);
}
test('Python generator and browser prompt rules agree on every fixture',()=>{
  const output=python('import sys,json; sys.path.insert(0,sys.argv[1]); from practice_engine import recall_prompt; print(json.dumps([recall_prompt(p,t) for p,t,_ in json.load(sys.stdin)],ensure_ascii=False))',fixtures);
  assert.deepEqual(output,fixtures.map(row=>row[2]));
});
test('Companion build_base_item integration preserves answers, bindings and other question types',()=>{
  const output=python(`import sys,json,copy
sys.path.insert(0,sys.argv[1])
import practice_engine as engine
point=json.load(sys.stdin)
card={"itemId":"synthetic-paper","abilityId":"topic:paper","domain":"course","title":"论文核心观点","pluginHint":"recall","sourceNote":"source.md","stateRef":"state.md","reviewPoints":[point,"另一项原始要点"]}
before=copy.deepcopy(card)
item=engine.build_base_item(card,{})
assert card==before
assert item["answer"]==item["explanation"]=="；".join(card["reviewPoints"])
assert item["fingerprint"]==engine.fingerprint_for(point,"source.md")
for field in ("itemId","abilityId","sourceNote","stateRef"): assert item[field]==card[field]
authored=engine.build_base_item(card,{"prompt":"为什么？","answer":"因为存在条件。"})
assert authored["prompt"]=="为什么？" and authored["answer"]=="因为存在条件。"
quiz=engine.build_base_item({**card,"pluginHint":"quiz"},{"prompt":"选择答案","answer":"A","wrong":["B"]})
assert quiz["questionType"]=="quiz" and quiz["answer"]==0
for kind in ("code","calculation"):
    other=engine.build_base_item({**card,"pluginHint":kind},{})
    assert other["questionType"]==kind and other["prompt"]==point
print(json.dumps(item,ensure_ascii=False))`,point);
  assert.equal(output.prompt,recallPrompt(legacy));
  assert.equal(output.questionType,'recall');
});

test('Python and TypeScript agree on legacy/new reading-only markers, and Python never calls a grader',()=>{
 const inputs=[
  {prompt:'请闭卷回忆「材料标题」的核心要点，并说明相关概念、依据或适用条件。',answer:'原文'},
  {prompt:'阅读材料：材料标题（待补具体问题）',answer:'原文'},
  {prompt:'为什么需要对照？',answer:'控制其他条件以比较目标因素。'},
 ];
 const output=python(`import sys,json
sys.path.insert(0,sys.argv[1])
from recall_quality import needs_concrete_recall_question
from practice_engine import grade_answer
values=json.load(sys.stdin)
def denied(*args): raise AssertionError('No external grader allowed')
for value in values[:2]:
    result=grade_answer({**value,'questionType':'recall'},'attempt',ai_available=True,recall_grader=denied)
    assert result['correct'] is None and '具体问题' in result['explanation']
print(json.dumps([needs_concrete_recall_question(v) for v in values]))`,inputs);
 assert.deepEqual(output,[true,true,false]);
});


test('already-published imperative prompts are reading material in both runtimes',()=>{
 const modern={...legacy,prompt:`请闭卷回答：${task}。`};
 const result=python('import sys,json; sys.path.insert(0,sys.argv[1]); from recall_quality import display_recall_prompt; print(json.dumps(display_recall_prompt(json.load(sys.stdin)),ensure_ascii=False))',modern);
 assert.equal(result,recallPrompt(modern));assert.match(result,/待补具体问题/);
});
