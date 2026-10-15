'use client';
import type {ReactNode} from 'react';
import type {PaperReadingUnit} from '../../domain/paper-reading';

export type PaperReadingPageProps = {
    title: string;
    identity?: string;
    unit: PaperReadingUnit;
    saving: boolean;
    navigationBlocked?: boolean;
    toolsBlocked?: boolean;
    error?: string;
    sourceAvailable: boolean;
    onOriginal?: () => void;
    onPosition: (position: number) => void;
    onCount: (count: number) => void;
    renderText: (text: string) => ReactNode;
    sources?: ReactNode;
    tools?: ReactNode;
    task?: ReactNode;
    original?: ReactNode;
    clock?: ReactNode;
    onLeave?: () => boolean;
    returnHref?: string;
};

export function PaperReadingPage(props: PaperReadingPageProps) {
    const {unit} = props;
    const locked = props.saving || Boolean(props.error) || Boolean(props.navigationBlocked);
    const next = unit.position + unit.paragraphs.length;
    return <section className="paper-focused-reading" aria-label="论文专注阅读">
        <header className="paper-reading-heading">
            <div><a href={props.returnHref??'/study'} onClick={event=>{if(props.onLeave?.()===false)event.preventDefault();}}>返回学习</a><h1>{props.title}</h1>{props.identity && <p>{props.identity}</p>}</div>
            {(props.saving||props.error)&&<p role="status">{props.saving ? '正在保存…' : '保存未完成'}</p>}
        </header>
        {props.error && <p role="alert">{props.error}</p>}
        {props.sources && <details><summary>更换论文或上传原文</summary>{props.sources}</details>}
        {props.clock}
        <nav className="paper-reading-unit-controls" aria-label="阅读范围">
            <div><strong>{unit.sectionTitle}</strong><span>第 {unit.position + 1} 段{unit.paragraphs.length > 1 ? `起，共 ${unit.paragraphs.length} 段` : ''}</span>
                {unit.physicalPages.length > 0 && <span>PDF 第 {unit.physicalPages.join('、')} 页</span>}</div>
            <label>阅读范围<select value={unit.paragraphs.length} disabled={locked} onChange={event => props.onCount(Number(event.target.value))}>
                {Array.from({length: unit.availableParagraphs}, (_, i) => i + 1).map(count =>
                    <option key={count} value={count}>{count === 1 ? '当前段' : `连续 ${count} 段`}</option>)}
            </select></label>
            {props.sourceAvailable && props.onOriginal ? <button type="button" onClick={props.onOriginal}>查看原页</button>
                : <span className="paper-source-limitation">原页暂不可用；原文与草稿保留。</span>}
        </nav>
        <div className="paper-reading-body">
            <article aria-label="当前单元原文">{unit.paragraphs.map(paragraph =>
                <section key={paragraph.id} data-paragraph-id={paragraph.id}>{props.renderText(paragraph.rawEn)}</section>)}</article>
            {props.original}
        </div>
        {props.task}
        <nav className="paper-reading-navigation" aria-label="阅读单元导航">
            <button type="button" disabled={locked || unit.position === 0} onClick={() => props.onPosition(unit.position - 1)}>上一段</button>
            <button type="button" disabled={locked || next >= unit.totalParagraphs} onClick={() => props.onPosition(next)}>下一段</button>
        </nav>
        {props.tools && <details><summary>更多工具</summary><div inert={props.toolsBlocked||undefined}>{props.tools}</div></details>}
    </section>;
}
