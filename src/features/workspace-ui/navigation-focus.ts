export type StudyFocusEntry={key:string|null;node:HTMLElement|null;fallbackKey?:string};
type FocusAction={kind:'none'}|{kind:'enter'}|{kind:'return';entry:StudyFocusEntry|null};

/** Only committed view identities move focus; question answers are not identities. */
export function createStudyNavigationFocus(){
  let owner:string|null=null,active:string|null=null,candidate:StudyFocusEntry|null=null,entrance:StudyFocusEntry|null=null;
  function reset(scope:string){owner=scope;active=null;candidate=null;entrance=null;}
  return {
    remember(scope:string,entry:StudyFocusEntry|null){if(owner===null)reset(scope);if(owner===scope&&active===null&&entry)candidate=entry;},
    transition(scope:string,next:string|null,destination:string):FocusAction{
      if(owner!==scope)reset(scope);
      if(active===next)return {kind:'none'};
      const previous=active;active=next;
      if(next!==null){if(previous===null)entrance=candidate;candidate=null;return {kind:'enter'};}
      const entry=entrance;entrance=null;
      return previous!==null&&destination==='today'?{kind:'return',entry}:{kind:'none'};
    },
  };
}

export function studyFocusEntry(target:Element|null):StudyFocusEntry|null{
  const node=target?.closest<HTMLElement>('button,a[href],summary');
  if(!node||!node.closest('.study-app.app-shell')||node.closest('.study-primary-session'))return null;
  const key=node.dataset.studyReturn??(node.id?`id:${node.id}`:node.matches('.dashboard-focus-actions .study-primary-action')?'today-primary':null);
  const group=node.closest<HTMLElement>('[data-study-group]')?.dataset.studyGroup;
  return {key,node,...(group?{fallbackKey:`group:${group}`}:{})};
}

function visible(node:HTMLElement|null):node is HTMLElement{
  return Boolean(node?.isConnected&&!(node as HTMLButtonElement).disabled&&node.getClientRects().length);
}
/** Recreated library buttons and closed navigation disclosures retain semantic identity. */
export function restoreStudyReturnFocus(root:Pick<ParentNode,'querySelector'|'querySelectorAll'>,entry:StudyFocusEntry|null):boolean{
  const byKey=(key:string)=>key==='today-primary'?root.querySelector<HTMLElement>('.dashboard-focus-actions .study-primary-action'):
    Array.from(root.querySelectorAll<HTMLElement>('[data-study-return],[id]')).find(node=>key.startsWith('id:')?node.id===key.slice(3):node.dataset.studyReturn===key)??null;
  let target:HTMLElement|null=null;
  if(entry?.key)target=byKey(entry.key);
  else if(entry?.node?.isConnected)target=entry.node;
  if(target){
    for(let parent=target.parentElement;parent;parent=parent.parentElement){
      if(parent.tagName==='DETAILS')(parent as HTMLDetailsElement).open=true;
      if(parent.hidden&&parent.id){
        const trigger=Array.from(root.querySelectorAll<HTMLElement>('[aria-controls]')).find(node=>node.getAttribute('aria-controls')?.split(/\s+/).includes(parent!.id));
        if(trigger?.getAttribute('aria-expanded')==='false'){trigger.click();return false;}
      }
    }
  }
  if(!visible(target)&&entry?.fallbackKey)target=byKey(entry.fallbackKey);
  if(!visible(target))target=root.querySelector<HTMLElement>('[data-study-return="today"]')??root.querySelector<HTMLElement>('.c-workspace-tab[aria-label="今日"]');
  if(!visible(target))return false;
  target.focus({preventScroll:true});target.scrollIntoView({block:'nearest',behavior:'instant'});return true;
}
