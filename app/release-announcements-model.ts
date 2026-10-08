export type ReleaseAnnouncement={version:string;date:string;title:string;changes:string[]};
const versionPattern=/^\d{1,4}\.\d{1,4}\.\d{1,4}$/;
export const announcementReceiptPrefix='zhixue:release-announcement:read:';
export function isNewerVersion(candidate:string,current:string):boolean {
  if(!versionPattern.test(candidate)||!versionPattern.test(current))return false;
  const next=candidate.split('.').map(Number),previous=current.split('.').map(Number);
  for(let i=0;i<3;i++){if(next[i]!==previous[i])return next[i]>previous[i];}
  return false;
}
export function validateAnnouncements(value:unknown,currentVersion:string):ReleaseAnnouncement[] {
  if(!Array.isArray(value)||!value.length)throw new Error('缺少版本公告');
  const seen=new Set<string>();
  for(const entry of value){
    if(!entry||typeof entry!=='object'||typeof entry.version!=='string'||!versionPattern.test(entry.version)||typeof entry.title!=='string'||!entry.title.trim()||entry.title.length>120||!Array.isArray(entry.changes)||!entry.changes.length||entry.changes.length>12||entry.changes.some((text:unknown)=>typeof text!=='string'||!text.trim()||text.length>600))throw new Error('公告字段无效');
    if(typeof entry.date!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(entry.date)||!Number.isFinite(Date.parse(entry.date))||new Date(entry.date).toISOString().slice(0,10)!==entry.date)throw new Error('公告日期无效');
    if(seen.has(entry.version))throw new Error('公告版本重复');
    seen.add(entry.version);
  }
  if(value[0].version!==currentVersion)throw new Error('当前版本必须有对应的最新公告');
  for(let i=1;i<value.length;i++)if(!isNewerVersion(value[i-1].version,value[i].version))throw new Error('公告必须按版本从新到旧排列');
  return value as ReleaseAnnouncement[];
}
export function createAnnouncementReceipt(getStorage:()=>Pick<Storage,'getItem'|'setItem'>){
  const acknowledged=new Set<string>();
  return {
    hasRead(version:string){
      if(acknowledged.has(version))return true;
      try{return getStorage().getItem(announcementReceiptPrefix+version)==='read';}catch{return false;}
    },
    acknowledge(version:string){
      acknowledged.add(version);
      try{getStorage().setItem(announcementReceiptPrefix+version,'read');}catch{/* Keep this mount usable when browser storage is unavailable. */}
    },
  };
}
