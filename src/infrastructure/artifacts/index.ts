/** Browser download adapter; callers must obtain user approval before invoking it. */
export function downloadStudyMaterial(name:string,text:string,type=name.endsWith('.json')?'application/json':'text/markdown'){
    const url=URL.createObjectURL(new Blob([text],{type}));
    const anchor=document.createElement('a');anchor.href=url;anchor.download=name;anchor.click();
    setTimeout(()=>URL.revokeObjectURL(url),500);
}
