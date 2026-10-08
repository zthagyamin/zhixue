export type GeneratedStartIntent={scope:string;hash:string;generation:number};
export function mayStartGeneratedPlan(intent:GeneratedStartIntent|null,scope:string,hash:string|undefined,visible:boolean,disabled=false,generation=intent?.generation){
 return Boolean(intent&&visible&&!disabled&&intent.scope===scope&&hash&&intent.hash===hash&&intent.generation===generation);
}
