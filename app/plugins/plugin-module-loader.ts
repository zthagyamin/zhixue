import type {StudyPlugin} from './registry';
/** One module request per descriptor; failures remain retryable, never learning results. */
export function createPluginModuleLoader<T>(id:string,load:()=>Promise<StudyPlugin<T>>){
 let pending:Promise<StudyPlugin<T>>|undefined;
 return ()=>{
  if(!pending)pending=Promise.resolve().then(load).then(plugin=>{
   if(plugin.id!==id||typeof plugin.renderUI!=='function')throw Error('plugin-module-mismatch');
   return plugin;
  }).catch(error=>{pending=undefined;throw error;});
  return pending;
 };
}
