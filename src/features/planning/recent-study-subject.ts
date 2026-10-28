export type RecentStudyRecord={eventType:string;occurredAt:string;itemKey:string;contentHash:string;verified:boolean};
export type RecentStudyItem={itemKey:string;contentHash:string;subjectId:string};
export type RecentStudySubject={kind:'checking'|'none'|'unavailable'}|{kind:'available';subjectId:string};

/** Select a verified subject, never a position or a substitute for missing evidence. */
export function recentStudySubject(input:{historyVerified:boolean;records:readonly RecentStudyRecord[];items:readonly RecentStudyItem[]}):RecentStudySubject{
  if(!input.historyVerified)return {kind:'checking'};
  const attempts=input.records.filter(record=>record.eventType==='practice-attempt');
  if(!attempts.length)return {kind:'none'};
  const dated=attempts.map(record=>({record,time:Date.parse(record.occurredAt)}));
  if(dated.some(value=>!Number.isFinite(value.time)))return {kind:'unavailable'};
  const newest=dated.reduce((latest,value)=>Math.max(latest,value.time),-Infinity);
  const candidates=dated.filter(value=>value.time===newest).map(value=>value.record);
  if(candidates.some(record=>!record.verified||!record.itemKey||!record.contentHash))return {kind:'unavailable'};
  const identities=new Set(candidates.map(record=>JSON.stringify([record.itemKey,record.contentHash])));
  if(identities.size!==1)return {kind:'unavailable'};
  const candidate=candidates[0];
  const matches=input.items.filter(item=>item.itemKey===candidate.itemKey&&item.contentHash===candidate.contentHash);
  const subjects=new Set(matches.map(item=>item.subjectId).filter(Boolean));
  if(subjects.size!==1||matches.some(item=>!item.subjectId))return {kind:'unavailable'};
  return {kind:'available',subjectId:[...subjects][0]};
}
