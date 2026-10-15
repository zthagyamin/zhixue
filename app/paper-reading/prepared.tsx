'use client';
import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {PaperReadingScope,PreparedPaperTaskSaveOptions} from '../../src/application/paper-reading';
import type {PaperReadingUnitV1,PreparedPaperTask} from '../../src/domain/paper-reading';
// @ts-expect-error TS5097: standalone Node contracts.
import {createPreparedPaperTaskService} from '../../src/application/paper-reading/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {createPreparedPaperTaskIndexedDbStore} from '../../src/infrastructure/paper-reading/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {openStudyDb} from '../local-study-db.ts';

function service(){return createPreparedPaperTaskService(createPreparedPaperTaskIndexedDbStore(openStudyDb),async text=>{
    const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text));
    return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');
});}
export function loadPreparedPaperTask(scope:PaperReadingScope,baseUnit:PaperReadingUnitV1){return service().load(scope,baseUnit);}
export function savePreparedPaperTask(scope:PaperReadingScope,baseUnit:PaperReadingUnitV1,packet:unknown,options?:PreparedPaperTaskSaveOptions){return service().save(scope,baseUnit,packet,options);}
export function exportPreparedPaperTaskTemplate(baseUnit:PaperReadingUnitV1){return service().exportTemplate(baseUnit);}

export function PreparedQuestionTools({unit,scope,beforeChange,onChange}:{unit:PaperReadingUnitV1;scope:PaperReadingScope;
    beforeChange:()=>Promise<void>;onChange:(prepared:PreparedPaperTask)=>void|Promise<void>}){
    const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
    const identity=JSON.stringify([scope,unit]),current=useRef(identity),mounted=useRef(true),flight=useRef(false);
    useLayoutEffect(()=>{current.current=identity;},[identity]);
    useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
    const valid=(expected:string)=>mounted.current&&current.current===expected;
    function download(){
        const url=URL.createObjectURL(new Blob([exportPreparedPaperTaskTemplate(unit)],{type:'application/json'}));
        const link=document.createElement('a');link.href=url;link.download='paper-prepared-question.json';link.click();URL.revokeObjectURL(url);
    }
    async function importFile(file:File){
        if(flight.current)return;
        flight.current=true;
        const expected=identity;let committed=false;setBusy(true);setError('');setNotice('');
        try{
            if(!file.name.toLowerCase().endsWith('.json')||file.size>128000)throw Error('请选择不超过 128 KB 的预备题 JSON 文件。');
            const packet=JSON.parse(await file.text());if(!valid(expected))return;
            const prior=await loadPreparedPaperTask(scope,unit);if(!valid(expected))return;
            await beforeChange();if(!valid(expected))return;
            const prepared=await savePreparedPaperTask(scope,unit,packet,{expectedRecipeHash:prior?.recipeHash??null});
            committed=true;
            if(!valid(expected))return;
            await onChange(prepared);if(valid(expected))setNotice('预备题已保存在本机，下次开始学习会优先使用；原题与原答保留。');
        }catch(reason){if(valid(expected))setError(committed?'预备题已保存在本机，但当前页面尚未切换，请刷新后重试；原题和原答保留。':preparedQuestionError(reason));}
        finally{flight.current=false;if(mounted.current)setBusy(false);}
    }
    return <details><summary>预备题</summary>
        <p>下载当前范围的模板，填写一个具体问题和原文引用，再导入。模板不包含账号信息。</p>
        <button type="button" disabled={busy} onClick={download}>下载预备题模板</button>
        <label>导入预备题<input type="file" accept=".json,application/json" disabled={busy}
            onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(file)void importFile(file);}}/></label>
        {busy&&<p role="status">正在校验并保存预备题…</p>}{notice&&<p role="status">{notice}</p>}{error&&<p role="alert">{error}</p>}
    </details>;
}
function preparedQuestionError(reason:unknown){
    const code=reason instanceof Error?reason.message:'';
    if(code==='paper-prepared-conflict')return '预备题已在另一页面改变。请重新导入；当前题目和答案保留。';
    if(code.startsWith('paper-prepared-corrupt'))return '已保存的预备题未通过完整性核对，无法覆盖。当前原文、题目和答案保留。';
    if(code.startsWith('paper-prepared-source'))return '预备题的原文版本或段落范围不匹配，请下载当前范围的模板。';
    if(code.startsWith('paper-prepared')||code.startsWith('paper-task'))return '预备题无效：请填写具体问题、有效能力和逐字原文引用，保留模板字段。';
    if(reason instanceof SyntaxError)return 'JSON 文件无法读取，请检查模板格式。';
    return code||'预备题尚未保存，请重试。';
}
