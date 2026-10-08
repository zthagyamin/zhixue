/** Restrict generated links to the read/open action. Never accept write or callback options. */
function hasControl(value:string){return [...value].some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)===127);}
export function safeObsidianReference(path:unknown):path is string{
 if(typeof path!=='string'||!path.trim()||path!==path.trim()||path.length>1500)return false;
 return !/^[\\/]|^[a-z][a-z\d+.-]*:/i.test(path)&&!path.includes('\\')&&!path.includes('?')&&!hasControl(path)&&
  path.split('#')[0].split('/').every(part=>part!=='.'&&part!=='..'&&part!=='');
}
export function buildObsidianOpenUri(vault:unknown,path:unknown,section?:string|null):string|null{
 if(typeof vault!=='string'||!vault.trim()||vault.length>200||hasControl(vault)||!safeObsidianReference(path))return null;
 if(section&&(section.length>1000||hasControl(section)))return null;
 try{return `obsidian://open?vault=${encodeURIComponent(vault.trim())}&file=${encodeURIComponent(path+(section?'#'+section:''))}`;}catch{return null;}
}
export function safeExistingObsidianUri(value:unknown):string|null{
 if(typeof value!=='string'||value.length>8000||hasControl(value))return null;
 try{
  const url=new URL(value),keys=[...url.searchParams.keys()];
  if(url.protocol!=='obsidian:'||url.hostname!=='open'||url.username||url.password||url.port||url.hash||!['','/'].includes(url.pathname)||new Set(keys).size!==keys.length||!keys.every(key=>['vault','file','path'].includes(key)))return null;
  const path=url.searchParams.get('path'),file=url.searchParams.get('file'),vault=url.searchParams.get('vault');
  if(path&&file||vault&&(!vault.trim()||hasControl(vault)))return null;
  if(path){if(!/^(?:\/|[a-z]:[\\/])/i.test(path)||hasControl(path)||path.split(/[\\/]/).includes('..'))return null;}
  else if(!safeObsidianReference(file))return null;
  return value;
 }catch{return null;}
}
export function obsidianPreferenceKey(scope:string){return 'zhixue:obsidian-open:v1:'+encodeURIComponent(scope);}
