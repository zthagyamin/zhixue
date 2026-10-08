import type {StudyAIProvider} from './study-ai-types';
export const DEEPSEEK_MODELS=[{id:'deepseek-v4-flash',label:'DeepSeek V4 Flash'},{id:'deepseek-v4-pro',label:'DeepSeek V4 Pro'},{id:'deepseek-v4-flash-vision-exp',label:'DeepSeek V4 Flash Vision（实验版）'}];
export function studyAIModelChoices(provider:StudyAIProvider,baseUrl:string,discovered:string[],current:string){
 let official=false;try{official=new URL(baseUrl).hostname==='api.deepseek.com';}catch{/* Invalid URLs cannot select provider defaults. */}
 const defaults=provider==='deepseek'&&official?DEEPSEEK_MODELS:[];
 const ids=[...new Set([...defaults.map(model=>model.id),...discovered,...(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(current)?[current]:[])])];
 return ids.map(id=>({id,label:defaults.find(model=>model.id===id)?.label??id}));
}
