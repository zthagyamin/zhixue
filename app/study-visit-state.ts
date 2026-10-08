// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {isNewerVersion} from './release-announcements-model.ts';

export const studyVisitPrefix='zhixue:study-visit:v1:';
const validVersion=(value:unknown):value is string=>typeof value==='string'&&/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(value);
type VisitRecord={firstVersion:string;latestVersion:string;upgradeVersion:string|null;welcomeDismissed:boolean};
export type StudyVisitDecision={version:string;firstVisit:boolean;showWelcome:boolean;announcementVersion:string|null};
function parse(raw:string|null):VisitRecord|null{
  try{
    const value=JSON.parse(raw??'null') as VisitRecord|null;
    if(!value||!validVersion(value.firstVersion)||!validVersion(value.latestVersion)||typeof value.welcomeDismissed!=='boolean')return null;
    if(value.upgradeVersion!==null&&(!validVersion(value.upgradeVersion)||value.upgradeVersion!==value.latestVersion))return null;
    if(isNewerVersion(value.firstVersion,value.latestVersion))return null;
    return {firstVersion:value.firstVersion,latestVersion:value.latestVersion,upgradeVersion:value.upgradeVersion,welcomeDismissed:value.welcomeDismissed};
  }catch{return null;}
}
/** Version exposure is not an announcement read receipt. No learning data is read or written. */
export function createStudyVisitSession(getStorage:()=>Pick<Storage,'getItem'|'setItem'>,scope:string){
  const key=studyVisitPrefix+encodeURIComponent(scope);
  let record:VisitRecord|null=null,decision:StudyVisitDecision|null=null;
  function persist(value:VisitRecord){try{getStorage().setItem(key,JSON.stringify(value));}catch{/* Keep learning usable without storage. */}}
  return {
    enter(version:string,alreadyIntroduced=false):StudyVisitDecision{
      if(!validVersion(version))throw new Error('Invalid study visit version');
      // React effect replay must not reclassify the same arrival as a returning user.
      if(decision?.version===version)return decision;
      let previous=record;
      try{previous=parse(getStorage().getItem(key))??previous;}catch{/* Unknown history stays non-interrupting. */}
      const firstVisit=previous===null;
      record=previous??{firstVersion:version,latestVersion:version,upgradeVersion:null,welcomeDismissed:alreadyIntroduced};
      if(isNewerVersion(version,record.latestVersion))record={...record,latestVersion:version,upgradeVersion:version};
      // Never lower the high-water mark when an older tab or a rollback is opened.
      persist(record);
      decision={version,firstVisit,showWelcome:!record.welcomeDismissed&&record.firstVersion===version,announcementVersion:record.upgradeVersion===version?version:null};
      return decision;
    },
    dismissWelcome(){
      if(!record||!decision)return;
      // Retain a newer version observed by another tab while closing this old welcome strip.
      let stored:VisitRecord|null=null;try{stored=parse(getStorage().getItem(key));}catch{/* In-memory fallback. */}
      if(stored&&isNewerVersion(stored.latestVersion,record.latestVersion))record=stored;
      record={...record,welcomeDismissed:true};persist(record);decision={...decision,showWelcome:false};
    },
  };
}
