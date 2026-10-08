// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {companionEndpointFromSearch} from './companion-endpoint.ts';
export const ONBOARDING_STEP_COUNT=7;
export type OnboardingProgress={version:1;step:number;path:'existing'|'new'|null;status:'active'|'skipped'|'completed'};
const key=(scope:string)=>'zhixue:onboarding:v1:'+encodeURIComponent(scope);
const LOGIN_KEY='zhixue:onboarding:login:v1';
export const initialOnboarding=():OnboardingProgress=>({version:1,step:0,path:null,status:'active'});
export function chooseOnboardingProgress(saved:OnboardingProgress|null,handoff:OnboardingProgress|null){return handoff?.status==='skipped'&&saved?.status==='completed'?saved:handoff??saved??initialOnboarding();}
function parse(value:unknown):OnboardingProgress|null{
  if(!value||typeof value!=='object')return null;const p=value as OnboardingProgress;
  return p.version===1&&Number.isInteger(p.step)&&p.step>=0&&p.step<ONBOARDING_STEP_COUNT&&[null,'existing','new'].includes(p.path)&&['active','skipped','completed'].includes(p.status)?{version:1,step:p.step,path:p.path,status:p.status}:null;
}
export function readOnboarding(storage:Pick<Storage,'getItem'>,scope:string):OnboardingProgress|null{try{return parse(JSON.parse(storage.getItem(key(scope))??'null'));}catch{return null;}}
export function saveOnboarding(storage:Pick<Storage,'setItem'>,scope:string,progress:OnboardingProgress):boolean{const value=parse(progress);if(!value)return false;try{storage.setItem(key(scope),JSON.stringify(value));return true;}catch{return false;}}
export function prepareOnboardingLogin(storage:Pick<Storage,'setItem'>,progress:OnboardingProgress,now=Date.now()):boolean{try{storage.setItem(LOGIN_KEY,JSON.stringify({progress,at:now}));return true;}catch{return false;}}
export function cancelOnboardingLogin(storage:Pick<Storage,'removeItem'>){try{storage.removeItem(LOGIN_KEY);}catch{/* An unavailable session store must not block navigation. */}}
export function onboardingStudyHref(search:string,setup=false){const port=new URL(companionEndpointFromSearch(search)).port;return '/study?'+new URLSearchParams({...setup?{pair:'1'}:{},companionPort:port});}
export function consumeOnboardingLogin(storage:Pick<Storage,'getItem'|'removeItem'>,userId:string|null,now=Date.now()):OnboardingProgress|null{
  if(!userId)return null;
  try{const raw=storage.getItem(LOGIN_KEY);storage.removeItem(LOGIN_KEY);const value=JSON.parse(raw??'null');return value&&typeof value.at==='number'&&now>=value.at&&now-value.at<=30*60*1000?parse(value.progress):null;}catch{return null;}
}

export const onboardingPublicPaths=['/','/help','/updates','/companion-guide'] as const;
export function normalizeOnboardingPath(pathname:string){
  const withoutQuery=(pathname||'/').split(/[?#]/)[0]??'/';
  const trimmed=withoutQuery.replace(/\/+$/,'');
  return trimmed||'/';
}
export function isPublicInformationPath(pathname:string){
  return (onboardingPublicPaths as readonly string[]).includes(normalizeOnboardingPath(pathname));
}
/**
 * Automatic tutorials only resume an explicitly started tutorial for a signed-in learner in the study
 * workspace. Public information pages, signed-out visitors and every other route stay closed
 * until the learner opens the tutorial from a visible control.
 */
export function shouldAutoOpenOnboarding(progress:OnboardingProgress,signedIn:boolean,pathname:string,resumeRequested=false){
  if(!resumeRequested||progress.status!=='active'||!signedIn)return false;
  const path=normalizeOnboardingPath(pathname);
  if(isPublicInformationPath(path))return false;
  return path==='/study'||path.startsWith('/study/');
}
