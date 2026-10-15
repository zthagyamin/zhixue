// @ts-expect-error TS5097: standalone Node contracts.
import {studyHash} from '../../domain/sync/index.ts';
/** Preserve existing logical request keys; bound derived keys for valid long opaque IDs. */
export async function paperReadingDerivedId(value:string,maxLength=200):Promise<string>{
    return value.length<=maxLength?value:'paper-derived:'+await studyHash(value);
}
