import test from 'node:test';
import assert from 'node:assert/strict';
import {readDashboardSource} from './helpers/dashboard-source.mjs';
import {dashboardIife,dashboardClick,dashboardFunction} from './fixtures/dashboard-functions.mjs';
import {readFileSync} from 'node:fs';

function selectLegacyFocus({done=[],missing=[],demo=false,minutes=[8,5]}={}){
  const starts=[],items=[{itemKey:'one',title:'One',estimatedMinutes:minutes[0]},{itemKey:'two',title:'Two',estimatedMinutes:minutes[1]}];
  const env={effectivePlan:{items,totalMinutes:13},isDemoMode:demo,isPlanEntryDone:entry=>done.includes(entry.itemKey),isDemoPlanEntryDone:entry=>done.includes(entry.itemKey),
    normalizedSubjects:[],uiProgress:{},progressEvents:[],currentDay:'2026-09-11',data:{},inputPoolPractice:key=>missing.includes(key)?undefined:{kind:'question'},
    practiceLoading:false,practiceItems:null,DashboardFocusHero:()=>null,startPlannedQuestionPractice:key=>starts.push(['question',key]),choosePlanVocabEntry:key=>starts.push(['vocab',key]),document:{}};
  const element=dashboardIife('const pending=effectivePlan.items.filter',env)();return{props:element.props,starts};
}

test('all completed entries disable both the primary action and its Space handler',()=>{
  for(const demo of [false,true]){
    const {props,starts}=selectLegacyFocus({done:['one','two'],demo});assert.equal(props.summary.groups,0);assert.equal(props.lead,null);assert.equal(props.disabled,true);
    props.onStart();assert.deepEqual(starts,[]);
    const source=readFileSync(new URL('../app/dashboard-focus-hero.tsx',import.meta.url),'utf8');
    assert.doesNotMatch(source,/addEventListener|startFromKeyboard/);
  }
});

test('an unresolved first entry does not hide a later executable question',()=>{
  const {props,starts}=selectLegacyFocus({missing:['one']});assert.equal(props.lead.taskId,'two');assert.equal(props.summary.blocked,1);
  props.onStart();assert.deepEqual(starts,[['question','two']]);
});

test('a wholly unresolved plan offers no executable lead',()=>{
  const {props,starts}=selectLegacyFocus({missing:['one','two']});assert.equal(props.lead,null);assert.equal(props.disabled,true);assert.equal(props.summary.blocked,2);
  props.onStart();assert.deepEqual(starts,[]);
});

test('remaining focus time excludes completed entries and preserves unknown estimates',()=>{
  assert.equal(selectLegacyFocus({done:['one']}).props.summary.minutes,5);
  assert.equal(selectLegacyFocus({minutes:[8,undefined]}).props.summary.minutes,null);
});

test('successful generation focuses the start action only while the learner remains on its trigger',async()=>{
  for(const scenario of ['success','focus-moved','plan-changed','failed','no-start']){
    let resolve,focused=0;const generated=new Promise(done=>{resolve=done;}),start={focus(){focused++;}},board={isConnected:true,dataset:{planHash:'new-plan'},querySelector:()=>scenario==='no-start'?null:start};
    const button={closest:()=>board},document={activeElement:button},frames=[];
    const click=dashboardClick('c-legacy-generate',{generateTodayPlan:()=>generated,document,requestAnimationFrame:callback=>frames.push(callback)});
    const pending=click({currentTarget:button});if(scenario==='focus-moved')document.activeElement={};if(scenario==='plan-changed')board.dataset.planHash='different-plan';
    resolve(scenario==='failed'?undefined:'new-plan');await pending;frames.forEach(callback=>callback());
    assert.equal(focused,scenario==='success'?1:0,scenario);
  }
});

test('a newly opened practice surface comes into view without stealing an editor or modal focus',()=>{
  for(const scenario of ['start','editing','dialog']){
    const calls=[],document={activeElement:{closest:()=>scenario==='editing'?{}:null},querySelector:()=>scenario==='dialog'?{}:null};
    const focus=dashboardFunction('focusPracticeSurface',{document});
    focus({focus:options=>calls.push(['focus',options]),scrollIntoView:options=>calls.push(['scroll',options])});focus(null);
    assert.deepEqual(calls,scenario==='start'?[['focus',{preventScroll:true}],['scroll',{block:'start',behavior:'instant'}]]:[],scenario);
  }
});

test('the today board leads with the focus hero and opens the first unfinished entry', async () => {
  const dashboard = await readDashboardSource();
  // Reusing the shipped hero keeps a single native keyboard-accessible start button.
  assert.match(dashboard, /<DashboardFocusHero summary=\{summary\} lead=\{leadEntry\?/);
  assert.match(dashboard, /const pending=effectivePlan\.items\.filter\(entry=>!\(isDemoMode\?/);
  assert.match(dashboard, /startPlannedQuestionPractice\(leadEntry\.itemKey\)/);
  assert.match(dashboard, /choosePlanVocabEntry\(leadEntry\.itemKey\)/);
  // The entry list stays reachable from the hero's secondary action.
  assert.match(dashboard, /id="today-plan-entries"/);
});

test('writing back to Obsidian is a secondary control that cannot fire while unpaired or offline', async () => {
  const dashboard = await readDashboardSource();
  const index = dashboard.indexOf('批准并写回');
  assert.ok(index > 0, 'the write-back control stays available');
  const button = dashboard.slice(Math.max(0, index - 1200), index + 40);
  assert.match(button, /border border-\[var\(--line\)\]/);
  assert.doesNotMatch(button, /bg-\[var\(--ink\)\][^"]*font-black/);
  assert.match(button, /disabled=\{planLoading\|\|!companionPlanClient\|\|syncState==='offline'\}/);
  assert.match(button, /连接 Companion 后可写回 Obsidian/);
});

test('a plan on screen leaves exactly one loud primary action', async () => {
  const dashboard = await readDashboardSource();
  // Regenerating stays orange only while no plan exists; with a plan the hero is the primary action.
  assert.match(dashboard, /\$\{effectivePlan\?'c-legacy-generate-secondary':''\}/);
  const styles = await (await import('node:fs/promises')).readFile(new URL('../app/study-overview.css', import.meta.url), 'utf8');
  assert.match(styles, /\.c-legacy-generate\.c-legacy-generate-secondary \{background:var\(--surface\);color:var\(--ink\);border:1px solid var\(--line\)/);
});
