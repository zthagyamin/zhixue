export type VaultMappingDiagnostic={code:string;path:string;message:string};
export type VaultMappingRule={pathGlob:string;subjectId:string;subjectLabel:string;contentKind:'vocabulary'|'quiz'|'code';splitMode:'heading'|'table'|'callout';headingLevel:number};
export type VaultMappingDocument={revision:number;rules:VaultMappingRule[];diagnostics?:VaultMappingDiagnostic[];schemaVersion?:number;contextId?:string};
export type VaultMappingInspection=VaultMappingDocument & {sampledFiles:number;sampleLimit:number;shapes:string[];confidence:number;ambiguous:boolean;active:false;diagnostics?:VaultMappingDiagnostic[];suggestions:VaultMappingRule[]};
export type VaultMappingPreview={revision:number;itemCount:number;diagnostics?:VaultMappingDiagnostic[];schemaVersion?:number;contextId?:string;previewId?:string;items:Array<{id:string;sourceNote:string;prompt?:string;word?:string;answer?:string;meaning?:string}>};
export function createVaultMappingClient({companionUrl,sessionToken,fetcher=fetch}:{companionUrl:string;sessionToken:string;fetcher?:typeof fetch}){
  const url=new URL(companionUrl);
  if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('Companion 地址必须是本机地址。');
  if(!sessionToken.trim())throw new Error('请先配对 Companion。');
  let inspectedContext:string|null=null,inspectionEpoch=0;
  const validContext=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
  const validPreview=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9]{32}$/.test(value);
  function requireContext(contextId?:string){
    if(!inspectedContext)throw new Error('请更新本机 Companion，然后重新读取学习库结构。');
    if(!validContext(contextId)||contextId!==inspectedContext)throw new Error('学习库来源已变化，请重新读取后预览。');
    return contextId;
  }
  async function request<T>(body?:unknown):Promise<T>{
    const response=await fetcher(new URL('/v1/vault-mapping',url),{method:body?'POST':'GET',headers:{'X-Study-Loop-Session':sessionToken,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const raw:unknown=await response.json();
    const value=raw&&typeof raw==='object'?raw as Record<string,unknown>:null;
    if(!response.ok)throw new Error(response.status===409?'映射已被其他操作更新，请重新读取后确认。':typeof value?.message==='string'?value.message:'映射请求失败。');
    if(!value||!Number.isInteger(value.revision))throw new Error('Companion 返回了无效的映射数据。');
    return value as T;
  }
  return {
    async inspect(){
      const epoch=++inspectionEpoch;inspectedContext=null;
      const value=await request<VaultMappingInspection>();
      if(epoch!==inspectionEpoch)throw new Error('学习库来源已变化，请重新读取后预览。');
      if(value.schemaVersion===2){
        if(!validContext(value.contextId))throw new Error('Companion 返回了无效的学习库来源，请重新读取。');
        inspectedContext=value.contextId;
      }
      return value;
    },
    async preview(rules:VaultMappingRule[],contextId?:string){
      const context=requireContext(contextId),epoch=inspectionEpoch;
      const value=await request<VaultMappingPreview>({action:'preview',rules,schemaVersion:2,contextId:context});
      if(epoch!==inspectionEpoch||value.schemaVersion!==2||value.contextId!==context||!validPreview(value.previewId))throw new Error('预览来源无效或已变化，请重新读取后预览。');
      return value;
    },
    async save(rules:VaultMappingRule[],revision:number,proof?:VaultMappingPreview){
      if(!proof||proof.schemaVersion!==2||!validContext(proof.contextId)||!validPreview(proof.previewId)||proof.revision!==revision)throw new Error('请重新预览提取结果后再确认保存。');
      const context=requireContext(proof.contextId),epoch=inspectionEpoch;
      const value=await request<VaultMappingDocument>({action:'confirm',rules,revision,schemaVersion:2,contextId:context,previewId:proof.previewId});
      if(epoch!==inspectionEpoch||value.schemaVersion!==2||value.contextId!==context)throw new Error('Companion 返回的保存来源已变化，请重新读取后确认。');
      return value;
    },
  };
}
export type VaultMappingClient=ReturnType<typeof createVaultMappingClient>;

