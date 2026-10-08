type TextClipboard={writeText:(text:string)=>Promise<void>};
/** Covers missing APIs, throwing getters and permission denial without a page error. */
export async function copyTextSafely(text:string,getClipboard:()=>TextClipboard|undefined=()=>navigator.clipboard):Promise<boolean>{
  try{
    const clipboard=getClipboard();
    if(typeof clipboard?.writeText!=='function')return false;
    await clipboard.writeText(text);return true;
  }catch{return false;}
}
