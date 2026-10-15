import type {StudyAIProvider} from './types';
// @ts-expect-error TS5097: standalone Node contracts.
import {providerEndpoint} from './endpoint.ts';

const OFFICIAL_ORIGINS=['https://api.openai.com','https://api.deepseek.com'];

function registeredOrigin(raw:unknown):string {
    if(typeof raw!=='string'||raw.length>300)throw Error('cloud-ai-destination-config');
    let url:URL;
    try{url=new URL(raw);}catch{throw Error('cloud-ai-destination-config');}
    const hostname=url.hostname;
    if(url.protocol!=='https:'||url.port||url.username||url.password||url.search||url.hash||url.pathname!=='/'
        ||!hostname.includes('.')||hostname.length>253
        ||!hostname.split('.').every(label=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
        ||!/[a-z]/.test(hostname.split('.').at(-1)!)
        ||/(?:^|\.)(?:localhost|local|internal|lan|home|corp|invalid|test)$/.test(hostname)
        ||hostname==='home.arpa'||hostname.endsWith('.home.arpa'))throw Error('cloud-ai-destination-config');
    return url.origin;
}

function registry(origins:readonly string[]):Set<string> {
    if(!Array.isArray(origins)||origins.length>32)throw Error('cloud-ai-destination-config');
    return new Set([...OFFICIAL_ORIGINS,...origins.map(registeredOrigin)]);
}

/** Deployment-owned JSON only; never read registry entries from an account request. */
export function parseCloudAIAllowedOrigins(raw?:string):readonly string[] {
    if(raw===undefined||raw.trim()==='')return [];
    if(raw.length>10000)throw Error('cloud-ai-destination-config');
    let values:unknown;
    try{values=JSON.parse(raw);}catch{throw Error('cloud-ai-destination-config');}
    if(!Array.isArray(values)||values.length>32)throw Error('cloud-ai-destination-config');
    return Object.freeze(values.map(registeredOrigin));
}

/** Build and authorize the same canonical target used by the cloud transport. */
export function cloudProviderEndpoint(options:{provider?:StudyAIProvider;baseUrl?:string;allowedOrigins?:readonly string[]}):string {
    const endpoint=providerEndpoint(options),url=new URL(endpoint);
    if(!registry(options.allowedOrigins??[]).has(url.origin))throw Error('cloud-ai-destination');
    return url.href;
}
