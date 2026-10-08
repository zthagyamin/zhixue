import test from 'node:test';
import assert from 'node:assert/strict';
import {conditionInPrompt} from '../src/features/course-study/condition-presentation.ts';

test('literal conditions and the explicit two-requirement sentence need no duplicate block',()=>{
    assert.equal(conditionInPrompt('在 x > 0 时计算。','x > 0'),true);
    assert.equal(conditionInPrompt('同一预约、用户、取消操作和时间点，其他适用条件也一致时，一条需求允许取消，另一条禁止取消，首要违反什么？',
        '两条需求针对同一预约、用户、取消操作和时间点，其他适用条件也一致'),true);
});

test('missing, conflicting or negated conditions remain visible',()=>{
    for(const [prompt,condition] of [['计算结果。','x > 0'],['不是同一时间，一条需求允许，另一条禁止。','两条需求针对同一时间'],
        ['两条需求针对不同用户。','两条需求针对同一用户'],['在 x < 0 时计算。','x > 0'],
        ['一条需求提到同一时间，另一条未写明时间。判断两条需求是否矛盾。','两条需求针对同一时间。'],
        ['请判断 x > 0 是否成立。','x > 0']]){
        assert.equal(conditionInPrompt(prompt,condition),false);
    }
});
