import test from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {loadTsx} from './fixtures/tsx-components.mjs';

function render({course=true,status='答案已保存在本机。',lessonStep='independent'}={}) {
    const {HostView}=loadTsx(new URL('../src/features/nonword-study/host-view.tsx',import.meta.url));
    return renderToStaticMarkup(createElement(HostView,{ready:true,busy:false,paused:false,submitted:false,
        intent:'review',lessonStep,purpose:lessonStep==='guided'?'guided':'first',status,elapsed:123,error:'',
        retryContinue:false,retryGrade:false,generation:0,reference:'说明',draft:{},
        lifecycle:{...(course?{course:{}}:{})},renderPlugin:()=>createElement('p',null,'题目正文'),
        actions:{chooseIntent(){},pause(){},beginGuided(){},beginIndependent(){}}}));
}

test('course status is concise and timing is available on demand',()=>{
    const html=render(),visible=html.replace(/<details[\s\S]*?<\/details>/g,'');
    assert.match(visible,/已保存/);
    assert.doesNotMatch(visible,/本组有效用时|按实际体验校准|达到时间仍可继续/);
    assert.match(html,/<summary>用时<\/summary>/);
    assert.match(html,/2 分 3 秒/);
    assert.match(html,/题目正文|日常复习|深入学习|暂停并保存/);
});

test('conflict and unsynced status never become a saved success',()=>{
    for(const status of ['保存失败，当前输入保留。','另一设备有不同作答或正式结果；本机答案保留，尚未覆盖。','答案已保存在本机，等待账号同步。']){
        const html=render({status});
        assert.match(html,status.includes('等待账号同步')?/待同步/:new RegExp(status));
    }
});

test('legacy host retains existing time and assistance copy',()=>{
    assert.match(render({course:false}),/本组有效用时|按实际体验校准/);
    assert.match(render({course:false,lessonStep:'guided'}),/不证明首轮独立通过/);
    assert.doesNotMatch(render({lessonStep:'guided'}),/结果保留为辅助尝试/);
});
