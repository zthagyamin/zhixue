// @ts-expect-error TS5097: standalone Node contracts.
import {canonicalSourceAdmissionJson} from '../../domain/source-admission/index.ts';
/** Python ledger ordering differs from the locale-sorted legacy attempt hash. */
export async function sourceAdmissionFingerprint(value:unknown):Promise<string>{
    const hash=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonicalSourceAdmissionJson(value)));
    return Array.from(new Uint8Array(hash),byte=>byte.toString(16).padStart(2,'0')).join('');
}
