import type {NonwordRecovery} from './index';
import type {RecoveryRow} from './database';
import type {LearningAttempt} from '../../domain/learning-attempt';
// @ts-expect-error TS5097: standalone Node source contracts.
import {canonicalAttemptJson} from '../../domain/learning-attempt/index.ts';
const key=(parts:unknown)=>canonicalAttemptJson(parts);
/** Missing pointers make the package partial; copied hashes do not manufacture an authority receipt. */
export function nonwordMissingDependencies(value:NonwordRecovery,formalCores:readonly {eventId:string;coreHash:string}[]):string[]{
 const missing=new Set<string>();
 const originalRows=value.databases.find(database=>database.kind==='attempts')?.stores.attempts??[];
 const originals=new Map(originalRows.map(row=>[key(row.key),row.attempt as LearningAttempt]));
 for(const database of value.databases){
  const aggregates=new Map((database.stores.attempts??database.stores.records??[]).map(row=>[key(row.key),row]));
  for(const queued of database.stores.outbox??[]){
   const row=aggregates.get(key(queued.key.slice(0,3)));
   const aggregate=row?.attempt??row?.evidence??row?.record;
   const operations=(aggregate as {operations?:{operationId:string;fingerprint:string;revision:number}[]}|undefined)?.operations??[];
   const mutation=queued.mutation as {operationId:string;expectedRevision:number};
   if(!row||!operations.some(operation=>operation.operationId===mutation.operationId&&operation.fingerprint===queued.fingerprint
     &&(database.kind==='course-evidence'||operation.revision===mutation.expectedRevision+1)))
    missing.add(`nonword-operation:${key(queued.key)}`);
  }
  if(database.kind==='course-evidence'||database.kind==='practice-evidence')for(const row of database.stores.records){
   const record=(row.evidence??row.record) as {binding:unknown;attemptId:string},original=originals.get(key(row.key));
   if(!original||record.attemptId!==original.attemptId||key(record.binding)!==key(original.binding))missing.add(`nonword-evidence-original:${key(row.key)}`);
  }
  if(database.kind==='attempts'){
   for(const row of database.stores.attempts){
    const attempt=row.attempt as LearningAttempt;
    if(attempt.parentAttemptId&&!aggregates.has(key([...row.key.slice(0,2),attempt.parentAttemptId])))missing.add(`nonword-parent:${key(row.key)}`);
    if(attempt.formal?.status==='linked'&&!formalCores.some(core=>core.eventId===attempt.formal!.eventId&&core.coreHash===attempt.formal!.coreHash))
     missing.add(`nonword-formal:${key(row.key)}`);
   }
   for(const row of database.stores.references){
    const attempt=aggregates.get(key(row.key))?.attempt as LearningAttempt|undefined,item=row.item as {itemKey?:string;contentHash?:string};
    if(!attempt||item.itemKey!==attempt.binding.itemKey||item.contentHash!==attempt.binding.contentHash)missing.add(`nonword-reference:${key(row.key)}`);
   }
  }
  if(database.kind==='native-course'||database.kind==='native-math'){
   const captures=new Map(database.stores.captures.map(row=>[key(row.key),row]));
   const captureFor=(row:RecoveryRow)=>captures.get(key([...row.key.slice(0,2),row.captureId]));
   for(const row of database.stores.captures){
    const capture=row.capture as {identity:unknown;captureId:string};
    if(!database.stores.identities.some(pointer=>key(pointer.key)===key([...row.key.slice(0,2),key(capture.identity)])&&pointer.captureId===capture.captureId))
     missing.add(`nonword-source-identity:${key(row.key)}`);
   }
   for(const row of [...database.stores.identities,...database.stores.attempts]){
    const capture=captureFor(row)?.capture as {identity?:unknown}|undefined;
    if(!capture||database.stores.identities.includes(row)&&row.key[2]!==key(capture.identity))missing.add(`nonword-source:${key(row.key)}`);
   }
   for(const row of database.stores.claims??[]){
    const claim=row.claim as {captureId:string};
    if(!captures.has(key([...row.key.slice(0,2),claim.captureId]))||!database.stores.attempts.some(link=>key(link.key)===key(row.key)&&link.captureId===claim.captureId))missing.add(`nonword-claim:${key(row.key)}`);
   }
  }
 }
 return [...missing].sort();
}
