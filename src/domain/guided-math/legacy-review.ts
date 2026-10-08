function canonical(value:unknown):string{
    if(Array.isArray(value))return JSON.stringify(value.map(item=>canonical(item)));
    if(value&&typeof value==='object')return JSON.stringify(Object.entries(value).filter(([,entry])=>entry!==undefined).sort(([a],[b])=>a.localeCompare(b)).map(([key,entry])=>[key,canonical(entry)]));
    return JSON.stringify(value);
}
/** A transport may only reorder existing choices or prefix the same recall prompt. */
export function acceptLegacyReview<T extends object>(source:T,candidate:unknown):{item:T;kind:'same-question'|'reordered-review'|'same-recall'}{
    if(!candidate||typeof candidate!=='object'||Array.isArray(candidate))throw Error('invalid-legacy-review');
    const old=source as Record<string,unknown>,next=candidate as Record<string,unknown>;
    if(canonical(source)===canonical(candidate))return {item:structuredClone(candidate) as T,kind:'same-question'};
    const expected={...old};let kind:'reordered-review'|'same-recall';
    if(old.questionType==='quiz'&&Array.isArray(old.options)&&Array.isArray(next.options)){
        const options=old.options,changed=next.options,index=Number(old.answer),newIndex=Number(next.answer);
        if(options.length<2||options.some(value=>typeof value!=='string')||new Set(options).size!==options.length||canonical([...options].sort())!==canonical([...changed].sort())||!Number.isInteger(index)||!Number.isInteger(newIndex)||index<0||newIndex<0||index>=options.length||newIndex>=changed.length||options[index]!==changed[newIndex])throw Error('changed-legacy-review-answer');
        expected.options=changed;expected.answer=next.answer;kind='reordered-review';
    }else if(old.questionType==='recall'&&typeof old.prompt==='string'&&['换个角度回忆：','再次回忆：'].some(prefix=>next.prompt===prefix+old.prompt)){
        expected.prompt=next.prompt;kind='same-recall';
    }else throw Error('changed-legacy-review-content');
    if(canonical(expected)!==canonical(next))throw Error('changed-legacy-review-binding');
    return {item:structuredClone(next) as T,kind};
}
export function assertSeparatedFamilies(rows:readonly {familyKey:string;parentItemKey:string;split:'development'|'holdout'}[]){
    const families=new Map<string,string>(),parents=new Map<string,string>();
    for(const row of rows){
        if(!row.familyKey||!row.parentItemKey||!['development','holdout'].includes(row.split))throw Error('invalid-evaluation-case');
        if(families.has(row.familyKey)&&families.get(row.familyKey)!==row.split)throw Error('evaluation-family-overlap');
        if(parents.has(row.parentItemKey)&&parents.get(row.parentItemKey)!==row.split)throw Error('evaluation-parent-overlap');
        families.set(row.familyKey,row.split);parents.set(row.parentItemKey,row.split);
    }
}
