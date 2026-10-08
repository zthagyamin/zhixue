import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import * as content from '../src/domain/content/index.ts';
import {adaptStudyItemForPlugin,resolvePluginType} from '../app/plugin-routing.ts';
import {studySubjectsWithPractice,selectPlannedPractice} from '../app/plan-runtime.ts';
import {checkContentQuality} from '../src/domain/assessment/index.ts';
import {tsxFunction} from './fixtures/tsx-functions.mjs';
import {sealStudyItem} from '../app/account-study-content.ts';

const contracts=JSON.parse(readFileSync(new URL('./fixtures/stage3-code-support-contract.json',import.meta.url),'utf8'));
const material=()=>({itemId:'sum',abilityId:'addition',domain:'python',sourceNote:'',stateRef:'',fingerprint:'synthetic',questionType:'code',pluginType:'code',prompt:'Implement add(a,b).',sourceLabel:'Synthetic',initialCode:'def add(a,b):\n    pass',explanation:'Return the sum.'});
const support=contracts.find(row=>row.valid).input;
const rows=[
    ...contracts.map(row=>({name:row.name,input:{...material(),learningSupport:row.input},valid:row.valid})),
    {name:'blank legacy script',input:{...material(),testCode:' \ufeff '},valid:false},
    {name:'missing legacy script',input:material(),valid:false},
    {name:'legacy script',input:{...material(),testCode:'assert add(1,2)==3'},valid:true},
    {name:'empty initial code',input:{...material(),initialCode:' ',learningSupport:support},valid:false},
    {name:'absent initial code',input:{...material(),initialCode:undefined,learningSupport:support},valid:false},
    {name:'malformed support with legacy script',input:{...material(),testCode:'assert True',learningSupport:{...support,cases:[]}},valid:false},
];
const pluginDataFor=tsxFunction(new URL('../app/practice-session.tsx',import.meta.url),'pluginDataFor',{
    QUESTION_TYPE_PLUGIN:{code:'@zhixue/plugin-code'},hasExecutableCodeMaterial:content.hasExecutableCodeMaterial,
});

for(const row of rows) test(`actual code routing and quality: ${row.name}`,()=>{
    const before=JSON.stringify(row.input);
    assert.equal(adaptStudyItemForPlugin('code',row.input)!==null,row.valid);
    assert.equal(checkContentQuality('code',row.input).capabilities.canAutoAssess,row.valid);
    assert.equal(pluginDataFor(row.input)?.id==='@zhixue/plugin-code',row.valid);
    const subjects=studySubjectsWithPractice([], [row.input]);
    assert.equal(subjects[0].pluginType,row.valid?'code':'flashcard');
    if(row.valid){
        assert.equal(resolvePluginType(row.input,'code','ai'),'code');
        const entry={itemKey:'practice:sum',domain:'python',kind:'review'};
        assert.deepEqual(selectPlannedPractice(entry,subjects,[])[0],row.input);
    }
    assert.equal(JSON.stringify(row.input),before);
});

test('actual plan conversion retains structured-only code mode',()=>{
    assert.equal(studySubjectsWithPractice([],[{...material(),learningSupport:support}])[0].pluginType,'code');
});
test('actual content quality accepts structured-only checks',()=>{
    assert.equal(checkContentQuality('code',{...material(),learningSupport:support}).capabilities.canAutoAssess,true);
});
test('actual practice-session adapter accepts structured-only code',()=>{
    assert.equal(pluginDataFor({...material(),learningSupport:support})?.id,'@zhixue/plugin-code');
});

test('actual Companion export and generation preserve valid structured-only material',async()=>{
    const script=`import json,sys
sys.path.insert(0,'companion')
from account_sync_export import export_catalog
from application.generated_content import validate_cards
from learning_support import has_executable_code_material
out=[]
for row in json.load(sys.stdin):
 item=row['input'];source={**item,'contentHash':'a'*64};key='practice:sum'
 binding={'subjectId':'code','signature':'a'*64,'documentPath':'source.md','sourceNote':'source.md','stateRef':'state.md','abilityId':'addition'}
 catalog={'active':True,'publicationEnabled':True,'subjects':[{'id':'code','name':'Synthetic','pluginType':'code','domain':'python','items':[source]}],'bindings':{key:binding},'sourceFingerprints':{'source.md':'b'*64}}
 result={}
 try:
  bundle,_=export_catalog(catalog,{},'library-a','snapshot-a',1,'2026-10-08T00:00:00.000Z');result['export']=bundle['items'][0]
 except ValueError:result['export']=None
 try:
  generated=validate_cards({'subjects':[{'id':'code','pluginType':'code','items':[item]}]},title='Synthetic',scope='Synthetic',seed={},stamp=lambda fmt:'2026-10-08',code_material_available=has_executable_code_material)
  result['generated']=generated['subjects'][0]['items'][0]
 except ValueError:result['generated']=None
 out.append(result)
print(json.dumps(out,ensure_ascii=True))`;
    const reply=spawnSync(process.env.PYTHON||'python',['-X','utf8','-c',script],{input:JSON.stringify(rows),encoding:'utf8',windowsHide:true,timeout:10000});
    assert.equal(reply.status,0,reply.stderr||reply.error?.message);
    for(const [index,result] of JSON.parse(reply.stdout).entries()){
        const row=rows[index];
        assert.equal(result.export?.practice.questionType==='code',row.valid,`${row.name}: export`);
        assert.equal(result.generated!==null,row.valid,`${row.name}: generated`);
        if(row.valid&&row.input.learningSupport){
            assert.deepEqual(result.export.learningSupport,row.input.learningSupport);
            assert.deepEqual(result.generated.learningSupport,row.input.learningSupport);
            const {contentHash,...body}=result.export;
            assert.equal((await sealStudyItem(body)).contentHash,contentHash,`${row.name}: Node/Python content signature`);
        }
    }
});

test('public execution capability predicates agree across shared V1 fixtures and legacy overrides',()=>{
    const parity=JSON.parse(readFileSync(new URL('./fixtures/stage3-code-support-parity.json',import.meta.url),'utf8'));
    const extra=[
        ...parity.map(row=>({name:row.name,input:{...material(),learningSupport:row.input},valid:row.valid})),
        {name:'structured checks with blank script',input:{...material(),testCode:'',learningSupport:support},valid:true},
        {name:'other support preserves legacy gate',input:{...material(),testCode:'assert True',learningSupport:{type:'recall'}},valid:true},
        {name:'other support cannot replace script',input:{...material(),learningSupport:{type:'recall'}},valid:false},
        {name:'JS-only BOM whitespace',input:{...material(),initialCode:'\ufeff',testCode:'assert True'},valid:false},
        {name:'Python-only whitespace remains code text',input:{...material(),initialCode:'\u0085',testCode:'assert True'},valid:true},
    ];
    const all=[...rows,...extra];
    for(const row of all) assert.equal(content.hasExecutableCodeMaterial(row.input),row.valid,row.name);
    const reply=spawnSync(process.env.PYTHON||'python',['-X','utf8','-c',"import json,sys;sys.path.insert(0,'companion');from learning_support import has_executable_code_material;print(json.dumps([has_executable_code_material(row['input']) for row in json.load(sys.stdin)]))"],{input:JSON.stringify(all),encoding:'utf8',windowsHide:true,timeout:10000});
    assert.equal(reply.status,0,reply.stderr||reply.error?.message);
    assert.deepEqual(JSON.parse(reply.stdout),all.map(row=>row.valid));
});
