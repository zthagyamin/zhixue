import type {SourceAdmissionJson} from './types';
const fail=():never=>{throw Error('source-admission-json');};
function scalarString(value:string):void {
    for(let index=0;index<value.length;index++){
        const unit=value.charCodeAt(index);
        if(unit>=0xd800&&unit<=0xdbff){
            const next=value.charCodeAt(++index);if(!(next>=0xdc00&&next<=0xdfff))fail();
        }else if(unit>=0xdc00&&unit<=0xdfff)fail();
    }
}
function compareKeys(left:string,right:string):number {
    const a=Array.from(left),b=Array.from(right);
    for(let i=0;i<Math.min(a.length,b.length);i++){
        const difference=a[i].codePointAt(0)!-b[i].codePointAt(0)!;
        if(difference)return difference;
    }
    return a.length-b.length;
}
/** Python receives JSON.stringify's wire number, then uses repr for parsed floats. */
function pythonNumber(value:number):string {
    if(!Number.isFinite(value))fail();
    const wire=JSON.stringify(value);
    if(!wire.includes('.')&&!wire.includes('e'))return wire;
    const sign=value<0?'-':'',text=Math.abs(value).toString();
    let digits:string,exponent:number;
    if(text.includes('e')){
        const [mantissa,power]=text.split('e');digits=mantissa.replace('.','');exponent=Number(power);
    }else{
        const point=text.includes('.')?text.indexOf('.'):text.length,all=text.replace('.','');
        const first=all.search(/[1-9]/);if(first<0)return'0';
        digits=all.slice(first).replace(/0+$/,'');exponent=point-first-1;
    }
    if(exponent<-4||exponent>=16){
        const coefficient=digits[0]+(digits.length>1?'.'+digits.slice(1):'');
        return sign+coefficient+'e'+(exponent<0?'-':'+')+String(Math.abs(exponent)).padStart(2,'0');
    }
    return wire;
}
function encode(value:unknown,depth:number):string {
    if(depth>32)fail();
    if(value===null)return'null';
    if(typeof value==='boolean')return String(value);
    if(typeof value==='string'){scalarString(value);return JSON.stringify(value);}
    if(typeof value==='number')return pythonNumber(value);
    if(Array.isArray(value))return'['+value.map(entry=>encode(entry,depth+1)).join(',')+']';
    if(value&&typeof value==='object'&&[Object.prototype,null].includes(Object.getPrototypeOf(value))){
        return'{'+Object.keys(value).sort(compareKeys).map(key=>{
            scalarString(key);return JSON.stringify(key)+':'+encode((value as Record<string,unknown>)[key],depth+1);
        }).join(',')+'}';
    }
    return fail();
}
/** Internal source-ledger fingerprint input; never a portable V3 event core. */
export function canonicalSourceAdmissionJson(value:unknown):string {
    const encoded=encode(value,0);
    if(new TextEncoder().encode(encoded).byteLength>500000)throw Error('source-admission-size');
    return encoded;
}
export function sourceAdmissionJson(value:unknown):SourceAdmissionJson {
    canonicalSourceAdmissionJson(value);
    return structuredClone(value) as SourceAdmissionJson;
}
export const sameSourceAdmission=(left:unknown,right:unknown)=>canonicalSourceAdmissionJson(left)===canonicalSourceAdmissionJson(right);
