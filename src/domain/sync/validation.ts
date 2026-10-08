// @ts-expect-error TS5097: standalone Node source contracts.
import {canonicalizeJson} from '../evidence/index.ts';
export function studyObject(value:unknown,required:string[],optional:string[]=[]):Record<string,unknown> {
  if (!value || typeof value!=='object' || Array.isArray(value)
    || ![Object.prototype,null].includes(Object.getPrototypeOf(value))) throw new Error('invalid-study-object');
  const object=value as Record<string,unknown>;
  if (Object.keys(object).some(key=>!required.includes(key)&&!optional.includes(key))) throw new Error('unknown-study-field');
  if (required.some(key=>!Object.hasOwn(object,key)||object[key]===undefined)) throw new Error('missing-study-field');
  return object;
}

export function studyText(value:unknown,label:string,max=4000,empty=false):asserts value is string {
  if (typeof value!=='string' || (!empty&&!value.trim())) throw new Error(`invalid-${label}`);
  if (value.length>max) throw new Error(`too-long-${label}`);
  if ([...value].some(char=>{const n=char.codePointAt(0)!;return (n<32&&n!==9&&n!==10&&n!==13)||n===127||(n>=0xd800&&n<=0xdfff);})) {
    throw new Error(`invalid-${label}`);
  }
}

export function studyId(value:unknown,label='identifier'):asserts value is string {
  studyText(value,label,200);
  if (value!==value.trim() || value.includes('/') || value.includes('\\')
    || [...value].some(char=>char.codePointAt(0)!<32||char.codePointAt(0)===127)) throw new Error(`invalid-${label}`);
}

export function studyDigest(value:unknown):asserts value is string {
  if (typeof value!=='string'||!/^[a-f0-9]{64}$/.test(value)) throw new Error('invalid-study-hash');
}

export function studyCount(value:unknown,label:string,min=0):asserts value is number {
  if (typeof value!=='number'||!Number.isSafeInteger(value)||value<min) throw new Error(`invalid-${label}`);
}

export function studyIso(value:unknown):asserts value is string {
  if (typeof value!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value)
    || !Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value) throw new Error('invalid-study-time');
}

export function studySize(value:unknown,max:number):void {
  let json:string|undefined;
  try {json=JSON.stringify(value);} catch {throw new Error('invalid-study-json');}
  if (json===undefined||new TextEncoder().encode(json).byteLength>max) throw new Error('study-payload-too-large');
}

export async function studyHash(value:unknown):Promise<string> {
  const bytes=new TextEncoder().encode(canonicalizeJson(value));
  const hash=await crypto.subtle.digest('SHA-256',bytes);
  return Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join('');
}
