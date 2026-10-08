/** Inspect range boundaries before reading selected text; settings are never attachments. */
export function studyAISelectedText(selection:Selection|null,root:Element|null,pageKind?:string):string{
 if(!selection||!root||pageKind==='sources'||selection.rangeCount!==1||selection.isCollapsed)return '';
 const privateSelector='form,input,textarea,[contenteditable=true],[data-ai-private]';
 for(const node of [selection.anchorNode,selection.focusNode]){
  const element=node?.nodeType===1?node as Element:node?.parentElement;
  if(!element||!root.contains(node)||element.closest(privateSelector))return '';
 }
 const range=selection.getRangeAt(0);
 try{for(const element of root.querySelectorAll(privateSelector))if(range.intersectsNode(element))return '';}catch{return '';}
 return selection.toString().slice(0,2000);
}
