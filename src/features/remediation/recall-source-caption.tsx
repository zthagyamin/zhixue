'use client';

/** Only per-item metadata is shown; the library's title is not evidence of this question's paper. */
export function RecallSourceCaption({label,prompt}:{label?:string;prompt:string}) {
    const source=typeof label==='string'?label.trim():'';
    if(!source||['论文核心观点','论文核心要点','Obsidian 到期复习'].includes(source)||prompt.trim().startsWith(source))return null;
    return <p className="study-meta" aria-label="本题来源" style={{overflowWrap:'anywhere'}}>来源材料：{source}</p>;
}
