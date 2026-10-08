import type {TrialQuestion} from './note-trial-model';
export const TRIAL_MATERIALS_CHANGED='zhixue:trial-materials-changed';
export const TRIAL_MATERIAL_OPEN='zhixue:trial-material-open';
export type TrialMaterialOpen={owner:string;library:string;questions:TrialQuestion[]};
export function openTrialMaterial(owner:string,library:string,questions:TrialQuestion[]){
 window.dispatchEvent(new CustomEvent<TrialMaterialOpen>(TRIAL_MATERIAL_OPEN,{detail:{owner,library,questions}}));
}
