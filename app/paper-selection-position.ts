export type PaperSelectionRect={left:number;right:number;top:number;bottom:number};
export function placePaperSelectionToolbar(anchor:PaperSelectionRect,size:{width:number;height:number},bounds:PaperSelectionRect,keepOpen=false){
  if(![...Object.values(anchor),...Object.values(size),...Object.values(bounds)].every(Number.isFinite))return null;
  const margin=8,gap=10,availableWidth=bounds.right-bounds.left-margin*2,availableHeight=bounds.bottom-bounds.top-margin*2;
  if(availableWidth<80||availableHeight<80)return null;
  const offscreen=anchor.bottom<=bounds.top||anchor.top>=bounds.bottom||anchor.right<=bounds.left||anchor.left>=bounds.right;
  if(offscreen&&!keepOpen)return null;
  const width=Math.min(size.width,availableWidth),height=Math.min(size.height,availableHeight);
  const below=bounds.bottom-margin-anchor.bottom-gap,above=anchor.top-gap-bounds.top-margin;
  const placement=offscreen?'viewport':below>=height?'below':above>=height?'above':'viewport';
  const desired=placement==='above'?anchor.top-gap-height:anchor.bottom+gap;
  const top=Math.max(bounds.top+margin,Math.min(desired,bounds.bottom-margin-height));
  const left=Math.max(bounds.left+margin,Math.min(anchor.left,bounds.right-margin-width));
  return{left,top,width,maxHeight:height,placement};
}
