export type AccountPageRequest={after:number;through?:number;limit:20;signal?:AbortSignal};
type Sequenced={sequence:number};
const object=(value:unknown):value is Record<string,unknown>=>Boolean(value&&typeof value==='object'&&!Array.isArray(value));
function cursor(value:unknown,label:string):number{
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)throw new Error('account-'+label+'-invalid');
  return value;
}

/** A completed read, never a partial checkpoint. Sequence gaps are valid across accounts. */
export async function readAccountPages<T extends Sequenced>(
  fetchPage:(request:AccountPageRequest)=>Promise<unknown>,
  options:{collection:string;after?:number;through?:number;signal?:AbortSignal;parse?:(row:unknown)=>T|Promise<T>},
):Promise<{rows:T[];through:number}>{
  let after=cursor(options.after??0,'cursor'),through=options.through===undefined?undefined:cursor(options.through,'fence');
  if(through!==undefined&&after>through)throw new Error('account-cursor-after-fence');
  const rows:T[]=[];
  while(true){
    options.signal?.throwIfAborted();
    const page=await fetchPage({after,limit:20,...(through===undefined?{}:{through}),...(options.signal?{signal:options.signal}:{})});
    options.signal?.throwIfAborted();
    if(!object(page)||!Array.isArray(page[options.collection]))throw new Error('account-page-invalid');
    const fence=cursor(page.through,'fence');through??=fence;
    if(fence!==through||after>fence)throw new Error('account-page-fence-changed');
    const rawRows=page[options.collection] as unknown[];
    if(rawRows.length>20)throw new Error('account-page-limit');
    let last=after;
    for(const raw of rawRows){
      options.signal?.throwIfAborted();
      if(!object(raw))throw new Error('account-page-row-invalid');
      const sequence=cursor(raw.sequence,'sequence');
      if(sequence<=last||sequence>fence)throw new Error('account-page-sequence');
      const value=options.parse?await options.parse(raw):raw as T;
      options.signal?.throwIfAborted();
      if(value.sequence!==sequence)throw new Error('account-parsed-sequence-changed');
      rows.push(value);last=sequence;
    }
    if(page.nextCursor===null){
      if(last!==fence)throw new Error('account-page-incomplete');
      return {rows,through:fence};
    }
    const next=cursor(page.nextCursor,'next-cursor');
    if(!rawRows.length||next!==last||next<=after||next>=fence)throw new Error('account-page-cursor');
    after=next;
  }
}
