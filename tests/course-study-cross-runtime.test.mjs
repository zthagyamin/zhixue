import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {resolveCourseSupportV2, resolveCourseTask, courseTaskHash, validateCourseDiagnostic,
  deterministicCourseDiagnostic, parseCourseDiagnostic, parseCourseEvaluationTrace,
  chooseCourseRemediation, courseDiagnosticOutcome, attemptEvaluationForDiagnostic,
  courseDiagnosticHash} from '../src/domain/course-study/index.ts';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/course-study-diagnostics-v1.json', import.meta.url)));
const python = process.env.PYTHON || 'python';
function item(support) {
  return {schemaVersion:2,kind:'practice',eventKind:'due',contentHash:'a'.repeat(64), learningSupport:structuredClone(support),
    practice:{questionType:support.type,prompt:support.task.prompt,domain:'course'}};
}
function rowDiagnostic(row) { return {...fixture.diagnosticBase,...row.diagnosticOverrides}; }
const pythonScript = `import sys,json
sys.path.insert(0,'companion')
from course_study_domain import *
results=[]
for case in json.load(sys.stdin):
 try:
  row=json.loads(case['inputJson'])
  op=row['op']
  if op=='task':
   value=resolve_course_task(row['item'],row.get('taskId'))
   result={'task':value,'hash':course_task_hash(value)}
  elif op=='diagnostic' or op=='quiz':
   task=resolve_course_task(row['item'])
   value=(validate_course_diagnostic(row['diagnostic'],task,row['answer']) if op=='diagnostic'
          else deterministic_course_diagnostic(task,row['answer']))
   value=validate_course_diagnostic(value,task,row['answer'])
   result={'diagnostic':value,'hash':course_diagnostic_hash(value,row.get('trace')),
           'outcome':course_diagnostic_outcome(value),
           'evaluation':attempt_evaluation_for_diagnostic(value,'a'*64),
           'remediation':choose_course_remediation(resolve_course_support_v2(row['item']),value)}
  elif op=='parse':
   value=parse_course_diagnostic(row['diagnostic'])
   result={'diagnostic':value,'hash':course_diagnostic_hash(value,row.get('trace'))}
  else:
   result=parse_course_evaluation_trace(row['trace'])
  results.append({'id':case['id'],'valid':True,'result':result})
 except (ValueError,TypeError,KeyError):
  results.append({'id':case['id'],'valid':False})
print(json.dumps(results,ensure_ascii=True))`;

async function check(cases) {
  const expected = await Promise.all(cases.map(async row => {
    try {
      const value = JSON.parse(row.inputJson);
      let result;
      if (value.op === 'task') {
        const task = resolveCourseTask(value.item,value.taskId);
        result = {task,hash:await courseTaskHash(task)};
      } else if (value.op === 'diagnostic' || value.op === 'quiz') {
        const task = resolveCourseTask(value.item);
        const diagnostic = validateCourseDiagnostic(value.op === 'diagnostic' ? value.diagnostic :
          deterministicCourseDiagnostic(task,value.answer),task,value.answer);
        result = {diagnostic,hash:await courseDiagnosticHash(diagnostic,value.trace ?? null),
          outcome:courseDiagnosticOutcome(diagnostic),evaluation:attemptEvaluationForDiagnostic(diagnostic,'a'.repeat(64)),
          remediation:chooseCourseRemediation(resolveCourseSupportV2(value.item),diagnostic)};
      } else if (value.op === 'parse') {
        const diagnostic = parseCourseDiagnostic(value.diagnostic);
        result = {diagnostic,hash:await courseDiagnosticHash(diagnostic,value.trace ?? null)};
      } else result = parseCourseEvaluationTrace(value.trace);
      return {id:row.id,valid:true,result};
    } catch { return {id:row.id,valid:false}; }
  }));
  assert.deepEqual(expected.map(row => row.valid),cases.map(row => row.valid),'fixture acceptance');
  const reply = spawnSync(python,['-X','utf8','-c',pythonScript],{
    input:JSON.stringify(cases),encoding:'utf8',windowsHide:true,timeout:10000,
  });
  assert.equal(reply.status,0,reply.stderr);
  assert.deepEqual(JSON.parse(reply.stdout),expected);
}
function entry(id,value,valid=true) { return {id,valid,inputJson:JSON.stringify(value)}; }

test('shared course diagnostic and quiz fixture has identical binding, evaluation, remediation and hashes', async () => {
  const cases = fixture.cases.map(row => entry(row.id,{op:'diagnostic',item:item(fixture.supports[row.supportId]),
    diagnostic:rowDiagnostic(row),answer:row.answer,trace:fixture.trace},row.valid));
  cases.push(...fixture.quizCases.map((row,index) => entry(`quiz-${index}`,{
    op:'quiz',item:item(fixture.quizSupport),answer:row.answer,trace:null},row.valid)));
  for (const reason of ['unavailable','offline','cancelled','source-insufficient','source-conflict','uncertain','invalid-result']) {
    const unknown = rowDiagnostic(fixture.cases.find(row => row.id === 'unknown'));
    cases.push(entry(`pending-${reason}`,{op:'diagnostic',item:item(fixture.supports.definition),
      diagnostic:{...unknown,reason},answer:'',trace:null}));
  }
  for (const status of ['correct','partial','incorrect']) cases.push(entry(`self-${status}`,{
    op:'diagnostic',item:item(fixture.supports.definition),answer:'',trace:null,
    diagnostic:{...fixture.diagnosticBase,status,source:'self-assess',matchedPointIds:[],pointEvidence:[]},
  }));
  const support = structuredClone(fixture.supports.partial);
  const mandatory = support.task.remediations[0];
  support.task.remediations.unshift({...structuredClone(mandatory),taskId:'error-retry',targetPointIds:['key']});
  const priority = {...fixture.diagnosticBase,status:'incorrect',matchedPointIds:[],missedPointIds:['extra'],errorPointIds:['key']};
  cases.push(entry('mandatory-before-error',{op:'diagnostic',item:item(support),
    diagnostic:priority,answer:fixture.cases[0].answer,trace:fixture.trace}));
  support.criteria[1].mandatory = false;
  cases.push(entry('error-before-optional',{op:'diagnostic',item:item(support),
    diagnostic:priority,answer:fixture.cases[0].answer,trace:fixture.trace}));
  const quiz = structuredClone(fixture.quizSupport);
  quiz.task.remediations.push({...structuredClone(quiz.task.remediations[0]),taskId:'missing-retry',
    targetPointIds:[],wrongOptionIds:[],missingOptionIds:['a']});
  cases.push(entry('option-author-order',{op:'quiz',item:item(quiz),answer:'["b"]',trace:null}));
  await check(cases);
});

test('parent, authored child and source version task hashes match without mutating the fixture', async () => {
  const before = structuredClone(fixture), cases = [];
  for (const [id,support] of Object.entries({...fixture.supports,quiz:fixture.quizSupport})) {
    cases.push(entry(`parent-${id}`,{op:'task',item:item(support)}));
    for (const child of support.task.remediations)
      cases.push(entry(`child-${id}-${child.taskId}`,{op:'task',item:item(support),taskId:child.taskId}));
    const changed = item(support);
    changed.learningSupport.task.sources[0].version = 'b'.repeat(64);
    cases.push(entry(`new-source-${id}`,{op:'task',item:changed}));
  }
  const original = item(fixture.supports.definition);
  for (const [key,value] of [['schemaVersion',true],['schemaVersion',1],['kind','word'],['eventKind','word']])
    cases.push(entry(`item-${key}-${value}`,{op:'task',item:{...original,[key]:value}},false));
  for (const key of ['answer','explanation','reviewPoint','options']) cases.push(entry(`legacy-${key}`,{
    op:'task',item:{...original,practice:{...original.practice,[key]:null}}},false));
  cases.push(entry('unknown-child',{op:'task',item:original,taskId:'missing'},false));
  await check(cases);
  assert.deepEqual(fixture,before);
});

test('closed fields, UTF-16, JS integral numbers and trace boundaries stay equal', async () => {
  const base = fixture.diagnosticBase;
  const cases = [entry('utf16-limit',{op:'parse',diagnostic:{...base,feedback:'😀'.repeat(2000)}}),
    entry('utf16-over',{op:'parse',diagnostic:{...base,feedback:'😀'.repeat(2001)}},false)];
  for (const literal of ['1.0','1e0']) {
    const row = entry(`version-${literal}`,{op:'parse',diagnostic:base});
    row.inputJson = row.inputJson.replace('"schemaVersion":1',`"schemaVersion":${literal}`);
    cases.push(row);
  }
  for (const patch of [{schemaVersion:true},{schemaVersion:1.5},{rating:'good'},
    {feedback:'\ud800'},{feedback:'\ufeff'},{feedback:'\x7f'},{matchedPointIds:['key\n']},
    {missedPointIds:['key']},{wrongOptionIds:['a'],missingOptionIds:['a']},
    {pointEvidence:[base.pointEvidence[0],base.pointEvidence[0]]},{reason:'uncertain'}])
    cases.push(entry(`closed-${cases.length}`,{op:'parse',diagnostic:{...base,...patch}},false));
  cases.push(entry('null-trace',{op:'trace',trace:null}),entry('trace',{op:'trace',trace:fixture.trace}));
  for (const patch of [{requestId:'request\n'},{provider:''},{extra:true}])
    cases.push(entry(`trace-${cases.length}`,{op:'trace',trace:{...fixture.trace,...patch}},false));
  for (const literal of ['2.0','2e0']) {
    const row = entry(`task-version-${literal}`,{op:'task',item:item(fixture.supports.definition)});
    row.inputJson = row.inputJson.replaceAll('"schemaVersion":2',`"schemaVersion":${literal}`);
    cases.push(row);
  }
  await check(cases);
});
