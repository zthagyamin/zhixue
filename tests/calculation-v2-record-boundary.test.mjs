import test from 'node:test';
import assert from 'node:assert/strict';
import {sealStudyItem} from '../app/account-study-content.ts';
import {sealStudyRecord,checkStudyRecordBinding} from '../app/account-study-record.ts';
import {withStudyEventCoreHash,SCHEDULER_VERSION} from '../app/study-event-v3.ts';
import {quizBody,recordBody} from './fixtures/account-study-fixtures.mjs';
import {attempt} from './fixtures/task-event-fixtures.mjs';
import {spawnSync} from 'node:child_process';
import {gradeCalculationReference} from '../app/calculation-grade.ts';

test('a calculation V2 optional step is not treated as a course task or scored in the formal result',async()=>{
    const body=quizBody({schemaVersion:2,learningSupport:{schemaVersion:2,type:'calculation',mode:'numeric',variables:[],domain:'real',
        step:{stepId:'subtract-baseline',prompt:'输入扣除背景值后的结果。',reference:'6',mode:'numeric'}}});
    body.practice={...body.practice,questionType:'calculation',prompt:'每分钟增加2单位，已有4单位，达到10单位需要几分钟？',answer:'3'};
    delete body.practice.options;
    const item=await sealStudyItem(body);
    const raw=await attempt('event-math-v2','2026-10-08T00:02:00Z',0,3,true,{scheduling:{reviewedAt:'2026-10-08T00:02:00.000Z',schedulerVersion:SCHEDULER_VERSION}});
    const event=await withStudyEventCoreHash({...raw,item:{...raw.item,kind:item.eventKind,key:item.itemKey}});
    const record=await sealStudyRecord(await recordBody({contentHash:item.contentHash,practiceMode:'calculation',event}));
    assert.equal(checkStudyRecordBinding(record,item),'ready');
    assert.equal(record.event.attempt.rating,'good');
    assert.equal(Object.hasOwn(record.event.attempt,'step'),false);
    const script="import json,sys;sys.path.insert(0,'companion');from account_sync_schema import check_record_binding;from practice_engine import grade_answer;from calculation_step import grade_calculation_step\nrow=json.load(sys.stdin)\nprint(json.dumps({'binding':check_record_binding(row['record'],row['item']),'final':grade_answer({'questionType':'calculation','answer':'3','learningSupport':row['item']['learningSupport']},'3',ai_available=False),'step':grade_calculation_step('7',row['item']['learningSupport'])}))";
    const reply=spawnSync(process.env.PYTHON||'python',['-X','utf8','-c',script],{input:JSON.stringify({item,record}),encoding:'utf8',windowsHide:true,timeout:10000});
    assert.equal(reply.status,0,reply.stderr);
    const actual=JSON.parse(reply.stdout);assert.equal(actual.binding,'ready');assert.equal(actual.final.correct,true);
    assert.equal(actual.step.status,'incorrect');assert.equal(Object.hasOwn(actual.step,'rating'),false);
});

test('a V2 symbolic result is pending when the kernel cannot interpret a source domain restriction',()=>{
    const item={answer:'x',learningSupport:{schemaVersion:2,type:'calculation',mode:'symbolic',variables:['x'],domain:'real',conditions:['x = 0']}};
    const result=gradeCalculationReference(item,'0');
    assert.equal(result.correct,null);assert.equal(result.verdict,'unknown');
    const script="import json,sys;sys.path.insert(0,'companion');from calculation_grade import grade_calculation_reference\nprint(json.dumps(grade_calculation_reference(json.load(sys.stdin),'0')))";
    const reply=spawnSync(process.env.PYTHON||'python',['-X','utf8','-c',script],{input:JSON.stringify(item),encoding:'utf8',windowsHide:true,timeout:10000});
    assert.equal(reply.status,0,reply.stderr);assert.equal(JSON.parse(reply.stdout).correct,null);
});
