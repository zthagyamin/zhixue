export type PracticeOrder='focus'|'mixed';
export type PracticeGroup={id:string;label:string};
type GroupItem={itemId:string;domain?:string;sourceLabel?:string;sourceNote?:string};

/** Explicit subject metadata may override this source-based fallback. Never infer a subject from question type. */
export function practiceGroup(item:GroupItem):PracticeGroup{
 const source=item.sourceNote?.trim()||item.sourceLabel?.trim();
 return {id:JSON.stringify(source?[item.domain??'',source]:['unclassified',item.itemId]),label:item.sourceLabel?.trim()||item.domain?.trim()||'未分类来源'};
}
export function orderPracticeItems<T extends GroupItem>(items:readonly T[],mode:PracticeOrder,groupFor:(item:T)=>PracticeGroup=practiceGroup,random:()=>number=Math.random):T[]{
 if(mode==='focus'){
  const groups=new Map<string,T[]>();
  for(const item of items){const key=groupFor(item).id,group=groups.get(key);if(group)group.push(item);else groups.set(key,[item]);}
  return [...groups.values()].flat();
 }
 const ordered=[...items];
 for(let i=ordered.length-1;i>0;i--){const value=random();if(!Number.isFinite(value)||value<0||value>=1)throw Error('Invalid shuffle source');const j=Math.floor(value*(i+1));[ordered[i],ordered[j]]=[ordered[j],ordered[i]];}
 return ordered;
}
/** Current question and completed prefix retain their exact references, including unsent drafts. */
export function reorderRemainingPracticeItems<T extends GroupItem>(items:readonly T[],currentIndex:number,mode:PracticeOrder,groupFor:(item:T)=>PracticeGroup=practiceGroup,random:()=>number=Math.random):T[]{
 const boundary=Math.min(items.length,Math.max(0,currentIndex+1));
 return [...items.slice(0,boundary),...orderPracticeItems(items.slice(boundary),mode,groupFor,random)];
}
