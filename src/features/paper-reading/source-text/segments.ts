export type PaperSourceSegment={kind:'text'|'math'|'code'|'inline-code';raw:string;start:number;end:number};

function escaped(text:string,index:number){
    let slashes=0;for(let i=index-1;i>=0&&text[i]==='\\';i--)slashes++;
    return slashes%2===1;
}
/** Display segmentation only; offsets use the original UTF16 string, without trim or normalization. */
export function paperSourceSegments(text:string):PaperSourceSegment[]{
    const result:PaperSourceSegment[]=[];let cursor=0,plain=0;
    function push(kind:PaperSourceSegment['kind'],start:number,end:number){
        if(start>plain)result.push({kind:'text',raw:text.slice(plain,start),start:plain,end:start});
        result.push({kind,raw:text.slice(start,end),start,end});cursor=end;plain=end;
    }
    while(cursor<text.length){
        if(escaped(text,cursor)){cursor++;continue;}
        if(text.startsWith('```',cursor)){
            const line=text.indexOf('\n',cursor+3),end=line<0?-1:text.indexOf('```',line+1);
            if(end<0)break;
            push('code',cursor,end+3);continue;
        }
        const marker=text.startsWith('$$',cursor)?'$$':text.startsWith('\\(',cursor)?'\\(':
            text.startsWith('\\[',cursor)?'\\[':text[cursor]==='$'?'$':text[cursor]==='`'?'`':null;
        if(!marker){cursor++;continue;}
        const closing=marker==='\\('? '\\)':marker==='\\['?'\\]':marker;
        let end=text.indexOf(closing,cursor+marker.length);
        while(end>=0&&(escaped(text,end)||(marker==='$'&&(text[end-1]==='$'||text[end+1]==='$'))))end=text.indexOf(closing,end+closing.length);
        if(end<0){if(marker!=='$'&&marker!=='`')break;cursor++;continue;}
        if((marker==='$'||marker==='`')&&text.slice(cursor+marker.length,end).includes('\n')){cursor++;continue;}
        // A whitespace-adjacent dollar pair commonly joins two currency amounts, not a formula.
        if(marker==='$'&&(/\s/.test(text[cursor+1])||/\s/.test(text[end-1]))){cursor++;continue;}
        if(end===cursor+marker.length){cursor+=marker.length;continue;}
        push(marker==='`'?'inline-code':'math',cursor,end+closing.length);
    }
    if(plain<text.length||result.length===0)result.push({kind:'text',raw:text.slice(plain),start:plain,end:text.length});
    return result;
}
/** A compatibility copy for the existing MathText renderer; source strings and IDs stay untouched. */
export function paperMathDisplayInput(raw:string):string{
    return raw.startsWith('\\[')&&raw.endsWith('\\]')?'$$'+raw.slice(2,-2)+'$$':raw;
}
/** Shared by pointer ranges and host keyboard/shift word selection. */
export function paperSourceSelectableRange(raw:string,start:number,end:number):{start:number;end:number}|null{
    if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start<0||end<=start||end>raw.length)return null;
    if(paperSourceSegments(raw).some(segment=>segment.kind!=='text'&&segment.end>start&&segment.start<end))return null;
    return {start,end};
}
