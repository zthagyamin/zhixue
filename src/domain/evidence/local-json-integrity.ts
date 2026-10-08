/** Integrity for local recovery/projection metadata, including finite FSRS
 * decimals. This is NOT the integer-only V3/account wire canonicalization. */
export function canonicalLocalJson(value:unknown):string{
  const stack=new Set<object>();
  const order=(a:string,b:string)=>{const left=Array.from(a,char=>char.codePointAt(0)!),right=Array.from(b,char=>char.codePointAt(0)!);
    for(let i=0;i<Math.min(left.length,right.length);i++)if(left[i]!==right[i])return left[i]-right[i];return left.length-right.length;};
  const visit=(value:unknown,depth:number):string=>{
    if(depth>64)throw new Error('invalid-local-json-depth');
    if(value===null||typeof value==='string'||typeof value==='boolean')return JSON.stringify(value);
    if(typeof value==='number'&&Number.isFinite(value))return JSON.stringify(value);
    if(typeof value!=='object'||!value||stack.has(value))throw new Error('invalid-local-json-value');
    stack.add(value);try{
      if(Array.isArray(value)){const rows:string[]=[];for(let i=0;i<value.length;i++){if(!(i in value))throw new Error('invalid-local-json-array');rows.push(visit(value[i],depth+1));}return'['+rows.join(',')+']';}
      if(![Object.prototype,null].includes(Object.getPrototypeOf(value)))throw new Error('invalid-local-json-object');
      const object=value as Record<string,unknown>;return'{'+Object.keys(object).filter(key=>object[key]!==undefined).sort(order).map(key=>JSON.stringify(key)+':'+visit(object[key],depth+1)).join(',')+'}';
    }finally{stack.delete(value);}
  };return visit(value,0);
}
export async function hashLocalJson(value:unknown):Promise<string>{
  const bytes=new TextEncoder().encode(canonicalLocalJson(value)),hash=await crypto.subtle.digest('SHA-256',bytes);
  return Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join('');
}
