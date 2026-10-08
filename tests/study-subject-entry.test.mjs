import test from 'node:test';
import assert from 'node:assert/strict';
import {dashboardFunction} from './fixtures/dashboard-functions.mjs';

for(const mode of ['native','account'])test(`today subject cards and navigation use grouped ${mode} planning`,()=>{
 const started=[];
 const navigate=dashboardFunction('navigateToStudyTab',{
  isDemoMode:false,accountLoaded:mode==='account'?{}:null,taskPlanningEnabled:mode==='native',
  planningNavigation:{startSubject:subject=>started.push(subject)},
  setTab:()=>assert.fail('Planned subjects must pass through source and grouping checks'),
 });
 assert.equal(navigate('speaking'),true);assert.deepEqual(started,['speaking']);
});
