'use client';
import type {ReactNode} from 'react';
import {LearningText} from '../../nonword-study';
import {paperSourceSegments,paperMathDisplayInput,paperSourceSelectableRange,type PaperSourceSegment} from './segments';

export type PaperSourceToken={text:string;start:number;end:number;isWord:boolean};
export type PaperSourceTextProps={text:string;className?:string;renderMath?:(text:string)=>ReactNode;
    tokens?:PaperSourceToken[];renderWord?:(token:PaperSourceToken)=>ReactNode};

/** A source view, never an edited source. Optional host tokens retain the existing occurrence IDs. */
export function PaperSourceText({text,className='',renderMath,tokens,renderWord}:PaperSourceTextProps){
    function plain(segment:PaperSourceSegment){
        const words=renderWord?tokens?.filter(token=>token.isWord&&token.start>=segment.start&&token.end<=segment.end):undefined;
        if(!words?.length)return <span data-paper-source-start={segment.start} data-paper-source-end={segment.end}>{segment.raw}</span>;
        const children:ReactNode[]=[];let position=segment.start;
        for(const token of words){
            if(!Number.isSafeInteger(token.start)||!Number.isSafeInteger(token.end)||token.start<position
                ||token.end<=token.start||text.slice(token.start,token.end)!==token.text)throw Error('paper-source-token-binding');
            if(position<token.start)children.push(<span key={'text:'+position} data-paper-source-start={position} data-paper-source-end={token.start}>{text.slice(position,token.start)}</span>);
            children.push(<span key={'word:'+token.start} data-paper-source-start={token.start} data-paper-source-end={token.end}>{renderWord!(token)}</span>);
            position=token.end;
        }
        if(position<segment.end)children.push(<span key={'text:'+position} data-paper-source-start={position} data-paper-source-end={segment.end}>{text.slice(position,segment.end)}</span>);
        return children;
    }
    function protectedSegment(segment:PaperSourceSegment){
        const Wrapper=segment.kind==='code'?'div':'span';
        return <Wrapper key={segment.start} data-paper-source-start={segment.start} data-paper-source-end={segment.end}
            data-paper-source-protected="true" data-paper-source-raw={segment.raw}>
            {segment.kind==='code'?<LearningText text={segment.raw}/>:
                segment.kind==='inline-code'?<code>{segment.raw.slice(1,-1)}</code>:
                    renderMath?renderMath(paperMathDisplayInput(segment.raw)):segment.raw}
        </Wrapper>;
    }
    return <div className={`nonword-text paper-source-text ${className}`.trim()} style={{whiteSpace:'pre-wrap',minWidth:0}}>
        {paperSourceSegments(text).map(segment=>segment.kind==='text'?<span key={segment.start}>{plain(segment)}</span>:
            protectedSegment(segment))}
    </div>;
}

function endpoint(root:HTMLElement,container:Node,offset:number,raw:string):number|null{
    if(!root.contains(container)||!Number.isSafeInteger(offset)||offset<0)return null;
    const element=container.nodeType===3?container.parentElement:container as Element;
    const span=element?.closest<HTMLElement>('[data-paper-source-start]');
    if(!span||!root.contains(span)||span.dataset.paperSourceProtected==='true')return null;
    const start=Number(span.dataset.paperSourceStart),end=Number(span.dataset.paperSourceEnd);
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<start||end>raw.length
        ||span.textContent!==raw.slice(start,end))return null;
    try{
        const prefix=root.ownerDocument.createRange();prefix.selectNodeContents(span);prefix.setEnd(container,offset);
        const length=prefix.toString().length;
        return length<=end-start?start+length:null;
    }catch{return null;}
}
/** DOM display lengths are never source offsets. Transformed regions fail closed. */
export function resolvePaperSourceSelection(root:HTMLElement,range:Range,raw:string):{start:number;end:number}|null{
    if(range.collapsed)return null;
    const start=endpoint(root,range.startContainer,range.startOffset,raw),end=endpoint(root,range.endContainer,range.endOffset,raw);
    if(start===null||end===null||start>=end)return null;
    return paperSourceSelectableRange(raw,start,end);
}
