export type CollapsedGroups=Record<string,boolean>;
export function parseCollapsedGroups(raw:string|null):CollapsedGroups{
 try{const value=JSON.parse(raw??'{}');if(!value||typeof value!=='object'||Array.isArray(value))return {};return Object.fromEntries(Object.entries(value).filter((entry):entry is [string,boolean]=>['language','computing','math','courses','other'].includes(entry[0])&&typeof entry[1]==='boolean'));}catch{return {};}
}
export function groupIsCollapsed(groups:CollapsedGroups,id:string,index:number,count:number,searching:boolean){return !searching&&(groups[id]??(count>=12&&index>0));}
export function libraryDisclosureKey(owner:string,library:string){return 'zhixue:library-disclosure:v1:'+encodeURIComponent(JSON.stringify([owner,library]));}
