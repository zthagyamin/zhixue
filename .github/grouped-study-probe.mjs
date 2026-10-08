/** DOM-only diagnostics for the isolated synthetic fixture; never shipped by the app. */
export function startGroupedStudyProbe({origin}){
    if(location.origin!==origin)return;
    const nodes=new WeakMap();let nextNode=0,last='';
    const identify=node=>{if(!node)return null;if(!nodes.has(node))nodes.set(node,++nextNode);return nodes.get(node);};
    const visible=selector=>[...document.querySelectorAll(selector)].filter(node=>node.getClientRects().length);
    const text=node=>node?.textContent?.trim().replace(/\s+/g,' ').slice(0,180)??null;
    const entries=[];window.__groupedTrace=entries;
    const snapshot=()=>{
      const bounds=node=>{const rect=node.getBoundingClientRect();return{x:rect.x,y:rect.y,width:rect.width,height:rect.height,documentY:rect.y+scrollY};};
      const button=visible('button').find(node=>/^再加 \d+ 条复习$/.test(text(node)??'')),rect=button?.getBoundingClientRect();
      const containers=selector=>visible(selector).map(node=>({node:identify(node),connected:node.isConnected}));
      return{scroll:{x:scrollX,y:scrollY},goal:visible('.study-review-goal strong').map(text),hero:visible('[aria-label="今日自测入口"]').map(text),
        layout:{hero:visible('[aria-label="今日自测入口"]').map(bounds),details:[...document.querySelectorAll('.study-plan-details')].map(node=>({node:identify(node),open:node.open,summary:node.querySelector('summary')?bounds(node.querySelector('summary')):null}))},
        containers:{groups:containers('.study-subject-task-groups'),goal:containers('.study-review-goal'),hero:containers('[aria-label="今日自测入口"]')},
        button:button?{node:identify(button),label:text(button),disabled:button.disabled,rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height}}:null};
    };
    const record=(kind,detail={})=>{const view=snapshot(),key=JSON.stringify(view);if(kind==='mutation'&&key===last)return;last=key;
      if(entries.length<1200)entries.push({ms:Math.round(performance.now()),kind,...detail,view});};
    window.__groupedSnapshot=record;
    for(const name of ['pointerdown','pointerup','click'])document.addEventListener(name,event=>{
      const target=event.target instanceof Element?event.target:null,button=target?.closest('button');
      record(name,{trusted:event.isTrusted,x:event.clientX,y:event.clientY,target:text(target),targetConnected:target?.isConnected??null,buttonNode:identify(button),buttonConnected:button?.isConnected??null,buttonLabel:text(button),disabled:button?.disabled??null});
    },true);
    new MutationObserver(()=>record('mutation')).observe(document,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['disabled','class','open']});
    document.addEventListener('DOMContentLoaded',()=>record('dom-ready'),{once:true});
    window.addEventListener('load',()=>record('load'),{once:true});
}

export async function installGroupedStudyProbe(context,origin){
  await context.addInitScript(startGroupedStudyProbe,{origin});
}

export async function groupedStudyTrace(page){
  return page.evaluate(()=>({url:location.pathname,entries:window.__groupedTrace??[]}));
}
