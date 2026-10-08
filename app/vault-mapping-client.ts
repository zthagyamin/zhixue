export type VaultMappingDiagnostic={code:string;path:string;message:string};
export type VaultMappingRule={pathGlob:string;subjectId:string;subjectLabel:string;contentKind:'vocabulary'|'quiz'|'code';splitMode:'heading'|'table'|'callout';headingLevel:number};
export type VaultMappingDocument={revision:number;rules:VaultMappingRule[];diagnostics?:VaultMappingDiagnostic[]};
export type VaultMappingInspection=VaultMappingDocument & {sampledFiles:number;sampleLimit:number;shapes:string[];confidence:number;ambiguous:boolean;active:false;diagnostics?:VaultMappingDiagnostic[];suggestions:VaultMappingRule[]};
export type VaultMappingPreview={revision:number;itemCount:number;diagnostics?:VaultMappingDiagnostic[];items:Array<{id:string;sourceNote:string;prompt?:string;word?:string;answer?:string;meaning?:string}>};
export function createVaultMappingClient({companionUrl,sessionToken,fetcher=fetch}:{companionUrl:string;sessionToken:string;fetcher?:typeof fetch}){
  const url=new URL(companionUrl);
  if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('Companion 地址必须是本机地址。');
  if(!sessionToken.trim())throw new Error('请先配对 Companion。');
  async function request<T>(body?:unknown):Promise<T>{
    const response=await fetcher(new URL('/v1/vault-mapping',url),{method:body?'POST':'GET',headers:{'X-Study-Loop-Session':sessionToken,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const raw:unknown=await response.json();
    const value=raw&&typeof raw==='object'?raw as Record<string,unknown>:null;
    if(!response.ok)throw new Error(response.status===409?'映射已被其他操作更新，请重新读取后确认。':typeof value?.message==='string'?value.message:'映射请求失败。');
    if(!value||!Number.isInteger(value.revision))throw new Error('Companion 返回了无效的映射数据。');
    return value as T;
  }
  return {inspect:()=>request<VaultMappingInspection>(),preview:(rules:VaultMappingRule[])=>request<VaultMappingPreview>({action:'preview',rules}),save:(rules:VaultMappingRule[],revision:number)=>request<VaultMappingDocument>({action:'confirm',rules,revision})};
}
export type VaultMappingClient=ReturnType<typeof createVaultMappingClient>;

