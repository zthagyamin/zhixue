import type {StudyBundle,StudySnapshot,StudyItemVersion} from './account-study-content';
import type {AccountReadModel} from './account-study-read-model';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {parseStudySnapshot,parseStudyItem,validateStudyBundle,studyCount,studyId,studyObject} from './account-study-content.ts';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {parseCloudPlanningCatalog,parseCloudPlanningFacts} from './account-study-planning.ts';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {parseStudyRecord} from './account-study-record.ts';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {readAccountPages} from './account-study-paging.ts';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {validateAccountReadModel,checkAccountReadAdvance} from './account-study-read-model.ts';

export type AccountCloudGet=(action:string,query?:Record<string,string|number>,signal?:AbortSignal)=>Promise<Record<string,unknown>>;
export async function readAccountModel(get:AccountCloudGet,boot:Record<string,unknown>,previous:AccountReadModel|null,signal?:AbortSignal):Promise<AccountReadModel>{
  signal?.throwIfAborted();if(!boot.snapshot)throw new Error('study-library-not-configured');const snapshot=await parseStudySnapshot(boot.snapshot),libraryId=snapshot.libraryId;
  if((boot.profile as {libraryId?:unknown})?.libraryId!==libraryId)throw new Error('account-bootstrap-library-binding');
  if(previous&&previous.loaded.bundle.snapshot.libraryId!==libraryId)throw new Error('account-library-changed');
  const query:AccountCloudGet=(action,params={})=>get(action,{...params,libraryId},signal);
  let fences:Record<string,unknown>|undefined;
  if(boot.readFences!==undefined){fences=studyObject(boot.readFences,['records','operations','receipts','executions']);for(const value of Object.values(fences))studyCount(value,'read-fence');}
  const read=async(collection:string,action:string,after:number,through?:number)=>readAccountPages(async page=>query(action,{after:page.after,limit:20,...(page.through===undefined?{}:{through:page.through})}),{collection,after,through,signal});
  const oldBundles=previous?.loaded.bundles??[],oldCatalogs=previous?.loaded.catalogs??[];
  const loadBundle=async(target:StudySnapshot):Promise<StudyBundle>=>{
    const cached=oldBundles.find(item=>item.snapshot.snapshotId===target.snapshotId);
    if(cached){if(cached.snapshot.snapshotHash!==target.snapshotHash)throw new Error('account-snapshot-conflict');return cached;}
    const items:StudyItemVersion[]=[];let position=0;
    while(true){signal?.throwIfAborted();const page=await query('items',{snapshotId:target.snapshotId,position,limit:20});signal?.throwIfAborted();
      if(!Array.isArray(page.items)||page.items.length>20)throw new Error('account-items-invalid');for(const raw of page.items)items.push(await parseStudyItem(raw));
      const next=position+page.items.length;if(page.nextPosition===null){if(next!==target.items.length)throw new Error('account-items-incomplete');break;}
      if(page.nextPosition!==next||next<=position||next>=target.items.length)throw new Error('account-items-cursor');position=next;}
    return validateStudyBundle({snapshot:target,items});
  };
  if(previous&&snapshot.revision<previous.loaded.bundle.snapshot.revision)throw new Error('account-snapshot-revision');
  const bundle=await loadBundle(snapshot),catalog=oldCatalogs.find(value=>value.snapshotId===snapshot.snapshotId)??await parseCloudPlanningCatalog(await query('planning-catalog',{snapshotId:snapshot.snapshotId})),
    facts=await parseCloudPlanningFacts(await query('planning-facts',{snapshotId:snapshot.snapshotId}));
  const operationPage=await read('operations','plan-operations',previous?.operationThrough??0,fences?.operations as number|undefined),
    executionPage=await read('executions','plan-executions',previous?.executionThrough??0,fences?.executions as number|undefined),
    receiptPage=await read('receipts','receipts',previous?.receiptThrough??0,fences?.receipts as number|undefined),
    recordPage=await readAccountPages(async page=>query('records',{after:page.after,limit:20,...(page.through===undefined?{}:{through:page.through})}),{collection:'records',after:previous?.loaded.eventThrough??0,through:fences?.records as number|undefined,signal,
      parse:async(raw:unknown)=>{const row=studyObject(raw,['sequence','record']);studyCount(row.sequence,'record-sequence',1);return{sequence:row.sequence,record:await parseStudyRecord(row.record)};}});
  const records=[...(previous?.loaded.records??[]),...recordPage.rows],operations=[...(previous?.operations??[]),...operationPage.rows];
  const bundles=[bundle,...oldBundles.filter(value=>value.snapshot.snapshotId!==snapshot.snapshotId)],catalogs=[catalog,...oldCatalogs.filter(value=>value.catalogHash!==catalog.catalogHash)];
  const needBundle=async(snapshotId:string)=>{if(!bundles.some(value=>value.snapshot.snapshotId===snapshotId)){studyId(snapshotId,'snapshot');const target=await parseStudySnapshot(await query('manifest',{snapshotId}));if(target.snapshotId!==snapshotId||target.libraryId!==libraryId)throw new Error('account-historical-snapshot-binding');bundles.push(await loadBundle(target));}};
  for(const snapshotId of new Set(records.map(row=>row.record.snapshotId))){await needBundle(snapshotId);if(!catalogs.some(value=>value.snapshotId===snapshotId))catalogs.push(await parseCloudPlanningCatalog(await query('planning-catalog',{snapshotId})));}
  for(const operation of operations){const hash=(operation as {plan?:{catalogHash?:unknown}|null}).plan?.catalogHash;if(typeof hash==='string'&&!catalogs.some(value=>value.catalogHash===hash)){
    const source=await parseCloudPlanningCatalog(await query('planning-catalog-hash',{catalogHash:hash}));if(source.catalogHash!==hash)throw new Error('account-operation-catalog-binding');catalogs.push(source);await needBundle(source.snapshotId);}}
  signal?.throwIfAborted();const result=await validateAccountReadModel({loaded:{bundle,bundles,catalog,catalogs,facts,records,writebacks:[...(previous?.loaded.writebacks??[]),...receiptPage.rows],eventThrough:recordPage.through,taskThrough:recordPage.through},operations,operationThrough:operationPage.through,receiptThrough:receiptPage.through,executions:[...(previous?.executions??[]),...executionPage.rows],executionThrough:executionPage.through},libraryId);
  signal?.throwIfAborted();if(previous)checkAccountReadAdvance(previous,result);return result;
}

type Flight={controller:AbortController;promise:Promise<unknown>;subscribers:number};
const pools=new WeakMap<typeof fetch,Map<string,Flight>>();
export function cancelSharedAccountReads(fetcher:typeof fetch,owner:string|number):void{
  const pool=pools.get(fetcher);if(!pool)return;
  for(const [key,flight]of pool)if(JSON.parse(key)[0]===owner){pool.delete(key);flight.controller.abort(new DOMException('Read cache cleared','AbortError'));}
}
/** One cancelled consumer cannot cancel another consumer's read. */
export function sharedAccountRead<T=AccountReadModel>(fetcher:typeof fetch,key:string,run:(signal:AbortSignal)=>Promise<T>,signal?:AbortSignal):Promise<T>{
  if(signal?.aborted)return Promise.reject(signal.reason??new DOMException('Cancelled','AbortError'));
  let pool=pools.get(fetcher);if(!pool){pool=new Map();pools.set(fetcher,pool);}let flight=pool.get(key);
  if(!flight){const controller=new AbortController();flight={controller,subscribers:0,promise:Promise.resolve().then(()=>{controller.signal.throwIfAborted();return run(controller.signal);})};pool.set(key,flight);}
  const selected=flight;selected.subscribers++;
  return new Promise((resolve,reject)=>{let settled=false;
    const leave=()=>{signal?.removeEventListener('abort',cancel);selected.controller.signal.removeEventListener('abort',cancel);selected.subscribers--;if(selected.subscribers===0){if(pool!.get(key)===selected)pool!.delete(key);selected.controller.abort();}};
    const cancel=()=>{if(settled)return;settled=true;leave();reject(signal?.reason??selected.controller.signal.reason??new DOMException('Cancelled','AbortError'));};
    signal?.addEventListener('abort',cancel,{once:true});
    selected.controller.signal.addEventListener('abort',cancel,{once:true});
    selected.promise.then(value=>{if(settled)return;settled=true;leave();resolve(structuredClone(value) as T);},error=>{if(settled)return;settled=true;leave();reject(error);});
    if(signal?.aborted)cancel();
  });
}
