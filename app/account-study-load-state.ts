import type {AccountStudyLoaded,createAccountStudyClient} from './account-study-client';
import type {StudyIdentity,AccountLoadStatus} from '../src/domain/sources';
export type {StudyIdentity,AccountLoadStatus} from '../src/domain/sources';
// @ts-expect-error TS5097: standalone Node source contracts.
import {parseStudyIdentity} from '../src/domain/sources/index.ts';
// @ts-expect-error TS5097: standalone Node source contracts.
export {accountLoadError,accountLoadLabel,accountLoadDetail} from '../src/domain/sources/index.ts';
// @ts-expect-error TS5097: standalone Node source contracts.
import {readAccountSource} from '../src/application/sources/index.ts';
export async function readStudyIdentity(response:Response):Promise<StudyIdentity|null>{
 if(!response.ok)throw Error('study-identity-unavailable');let value:unknown;try{value=await response.json();}catch{throw Error('study-identity-invalid');}return parseStudyIdentity(value);
}
export function loadAccountForPage(input:{identity:StudyIdentity|null;local:boolean;signal?:AbortSignal;client:Pick<ReturnType<typeof createAccountStudyClient>,'cached'|'load'>;onStatus:(value:AccountLoadStatus)=>void;apply:(value:AccountStudyLoaded,freshness:'cache'|'latest')=>Promise<boolean>;onIdentityChanged?:()=>void}){return readAccountSource({...input,now:()=>new Date().toISOString()});}
