export type StudyDevicePrincipal={kind:'device';userId:string;libraryId:string;grantId:string;state:'pending'|'active';expiresAt:string};

/** A dedicated locally-generated machine credential, never a browser login or AI key. */
export async function machineTokenHash(secret:unknown):Promise<string> {
  if(typeof secret!=='string'||secret.length<43||secret.length>128||!/^[A-Za-z0-9_-]+$/.test(secret)) throw new Error('invalid-machine-token');
  const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(secret));
  return Array.from(new Uint8Array(hash),value=>value.toString(16).padStart(2,'0')).join('');
}
