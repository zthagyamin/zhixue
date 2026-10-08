const versionPattern=/^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
export function parseRelease(value:unknown):string|null {
  if(!value||typeof value!=='object')return null;
  const record=value as Record<string,unknown>;
  return record.schemaVersion===1&&typeof record.version==='string'&&versionPattern.test(record.version)?record.version:null;
}
export function makeDiagnosticReport(input:{version:string;companionVersion?:string|null;pathname:string;userAgent:string;digest?:string;now:Date}):string {
  const version=(value:unknown)=>typeof value==='string'&&versionPattern.test(value)?value:'未知';
  const browser=/(Edg|Firefox|Chrome|Version)\/(\d{1,3})(?:\.|\s|$)/.exec(input.userAgent);
  const browserName=browser?({Edg:'Edge',Firefox:'Firefox',Chrome:'Chrome',Version:'Safari'}[browser[1]]??'其他')+' '+browser[2]:'未知';
  const route=input.pathname==='/'?'首页':input.pathname==='/study'?'学习工作台':input.pathname==='/help'?'帮助':input.pathname==='/updates'?'更新说明':'其他页面';
  // Do not accept arbitrary error messages/digests, local paths, URL queries or raw UA.
  const digest=input.digest&&/^\d{1,20}$/.test(input.digest)?input.digest:'未提供';
  return ['知学诊断报告（请预览后自行分享）',`生成时间：${input.now.toISOString()}`,`网页版本：${version(input.version)}`,`Companion 版本：${version(input.companionVersion)}`,`页面：${route}`,`浏览器：${browserName}`,`故障编号：${digest}`,'保存与同步状态：本报告未核验，请在工作台查看。'].join('\n');
}
