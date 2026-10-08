/** Only operating-system necessities and explicitly bounded fixture controls reach Python. */
export function previewEnvironment(source,reuse) {
  const allowed=new Set(['PATH','SYSTEMROOT','WINDIR','TEMP','TMP','COMSPEC']);
  const env=Object.fromEntries(Object.entries(source).filter(([key])=>allowed.has(key.toUpperCase())));
  env.PYTHONNOUSERSITE='1';env.PYTHONUTF8='1';
  const count=source.TASK_PLAN_REVIEW_COUNT;
  if(count!==undefined){if(!/^\d+$/.test(count)||Number(count)>2000)throw new Error('Fixture review count must be 0..2000');env.TASK_PLAN_REVIEW_COUNT=count;}
  if(reuse)env.TASK_PLAN_REUSE_VAULT='1';
  return env;
}
/** Optional localhost-only QA shim, never imported by the application bundle. */
export function previewHtml(html,silentAudio){
  if(!silentAudio)return html;
  return html.replace(/<head(?:\s[^>]*)?>/i,tag=>tag+'<script data-preview-audio="off">Object.defineProperty(window,"speechSynthesis",{value:undefined,configurable:true});</script>');
}
