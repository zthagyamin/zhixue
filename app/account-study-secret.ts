function bytes(value:string):Uint8Array<ArrayBuffer>{try{const normalized=value.replace(/-/g,'+').replace(/_/g,'/').padEnd(Math.ceil(value.length/4)*4,'='),decoded=atob(normalized),result=new Uint8Array(new ArrayBuffer(decoded.length));for(let index=0;index<decoded.length;index++)result[index]=decoded.charCodeAt(index);return result;}catch{throw new Error('account-ai-encryption-key-invalid');}}
function encoded(value:Uint8Array):string{return btoa(String.fromCharCode(...value)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');}
async function key(raw:string):Promise<CryptoKey>{const material=bytes(raw);if(material.byteLength!==32)throw new Error('account-ai-encryption-key-invalid');return crypto.subtle.importKey('raw',material,{name:'AES-GCM'},false,['encrypt','decrypt']);}
function aad(userId:string,libraryId:string):Uint8Array<ArrayBuffer>{const source=new TextEncoder().encode(`account-study-ai\u0000${userId}\u0000${libraryId}\u0000v1`),result=new Uint8Array(new ArrayBuffer(source.byteLength));result.set(source);return result;}
function utf8(value:string):Uint8Array<ArrayBuffer>{const source=new TextEncoder().encode(value),result=new Uint8Array(new ArrayBuffer(source.byteLength));result.set(source);return result;}
export async function encryptAccountAiKey(master:string,scope:{userId:string;libraryId:string},providerKey:string):Promise<{ciphertext:string;nonce:string}>{
  const nonce=crypto.getRandomValues(new Uint8Array(new ArrayBuffer(12))),cipher=await crypto.subtle.encrypt({name:'AES-GCM',iv:nonce,additionalData:aad(scope.userId,scope.libraryId)},await key(master),utf8(providerKey));
  return{ciphertext:encoded(new Uint8Array(cipher)),nonce:encoded(nonce)};
}
export async function decryptAccountAiKey(master:string,scope:{userId:string;libraryId:string},ciphertext:string,nonce:string):Promise<string>{
  try{const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(nonce),additionalData:aad(scope.userId,scope.libraryId)},await key(master),bytes(ciphertext)),value=new TextDecoder('utf-8',{fatal:true}).decode(plain);if(!value.trim()||value.length>512)throw new Error();return value;}catch(error){if(error instanceof Error&&error.message==='account-ai-encryption-key-invalid')throw error;throw new Error('account-ai-credential-unavailable');}
}
