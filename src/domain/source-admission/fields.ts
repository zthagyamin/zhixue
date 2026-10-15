import type {SourceAdmissionBinding} from './types';
// @ts-expect-error TS5097: standalone Node contracts.
import {sourceAdmissionJson} from './json.ts';
export function sourceAdmissionFields(raw:unknown,required:readonly string[],optional:readonly string[]=[]):Record<string,unknown>{
    if(!raw||typeof raw!=='object'||Array.isArray(raw)||![Object.prototype,null].includes(Object.getPrototypeOf(raw))
        ||required.some(key=>!Object.hasOwn(raw,key))||Object.keys(raw).some(key=>!required.includes(key)&&!optional.includes(key)))
        throw Error('source-admission-fields');
    return sourceAdmissionJson(raw) as Record<string,unknown>;
}
export function sourceAdmissionId(raw:unknown):string {
    if(typeof raw!=='string'||!raw.trim()||raw!==raw.trim()||Array.from(raw).length>200
        ||Array.from(raw).some(character=>character.codePointAt(0)!<32||character.codePointAt(0)===127)||/\p{Surrogate}/u.test(raw))
        throw Error('source-admission-identifier');
    return raw;
}
export function sourceAdmissionHash(raw:unknown):string {
    if(typeof raw!=='string'||!/^[a-f0-9]{64}$/u.test(raw))throw Error('source-admission-hash');return raw;
}
export function sourceAdmissionCaptureId(raw:unknown):string {
    const id=sourceAdmissionId(raw);if(!/^source-capture:[a-f0-9]{64}$/u.test(id))throw Error('source-admission-capture-binding');return id;
}
export function sourceAdmissionTime(raw:unknown,formal=true):string {
    if(typeof raw!=='string'||raw.length>100||!Number.isFinite(Date.parse(raw)))throw Error('source-admission-time');
    if(formal&&(!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(raw)||raw.startsWith('0000-')||new Date(raw).toISOString()!==raw))
        throw Error('source-admission-time');
    if(!formal&&!/T.+(?:Z|[+-]\d\d:\d\d)$/u.test(raw))throw Error('source-admission-time');return raw;
}
export function parseSourceAdmissionBinding(raw:unknown):SourceAdmissionBinding {
    const r=sourceAdmissionFields(raw,['ownerId','libraryId','itemKey','contentHash','captureId']);
    for(const key of ['ownerId','libraryId','itemKey'])sourceAdmissionId(r[key]);
    sourceAdmissionHash(r.contentHash);sourceAdmissionCaptureId(r.captureId);return r as SourceAdmissionBinding;
}
