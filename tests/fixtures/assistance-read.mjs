import {readFile} from 'node:fs/promises';
import {sealAccountAssistance} from '../../app/assistance-record.ts';
const vector=JSON.parse(await readFile(new URL('./account-study-v1.json',import.meta.url))),summary=JSON.parse(await readFile(new URL('./assistance-summary-v1.json',import.meta.url)));
export function assistanceBundle(){return structuredClone(vector.bundle);}
export async function assistanceView(){const parent=vector.records[0],record=await sealAccountAssistance(parent,summary);return{schemaVersion:1,workspaceId:'account:a',libraryId:parent.libraryId,summaryThrough:3,receiptThrough:0,summaries:[{sequence:3,record,parent,receivedAt:'2026-09-01T00:01:00.000Z'}],receipts:[]};}
