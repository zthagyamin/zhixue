'use client';

/** Reading an incomplete source is available without inventing a learner attempt. */
export function RecallMaterialNotice({title,reference,onNext,disabled=false}:{title?:string;reference?:string|null;onNext?:()=>void;disabled?:boolean}) {
    return <section className="study-card study-feedback" aria-label="待完善的阅读材料">
        <h2>{title||'阅读材料'}</h2>
        <p role="status">待补具体问题，暂不自测。</p>
        <p>原文和已有记录保留。这份材料需要补充一个明确的问题及对应参考答案，阅读不会产生新成绩。</p>
        {reference&&<details><summary>查看原始摘记（仍需核对）</summary><p style={{whiteSpace:'pre-wrap'}}>{reference}</p></details>}
        {onNext&&<button type="button" className="study-secondary-action" disabled={disabled} onClick={()=>{if(!disabled)onNext();}}>下一项，不计成绩</button>}
    </section>;
}
