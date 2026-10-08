import type {StudyScope} from './account-study-store';
import type {AccountAssistanceV1,AssistanceReceiptV1} from '../app/assistance-record';
import type {StudyRecordEnvelope} from '../app/account-study-record';
// @ts-expect-error TS5097: standalone Node contracts.
import {parseAccountAssistance,validateAccountAssistance,parseAssistanceReceipt,checkAssistanceReceipt} from '../app/assistance-record.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {parseStudyRecord} from '../app/account-study-record.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {studyObject,studyId,studyCount,studyHash} from '../app/account-study-content.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {canonicalizeJson} from '../app/study-event-v3.ts';

type SummaryRow={sequence:number;user_id:string;library_id:string;summary_id:string;event_id:string;summary_hash:string;association_hash:string;record_json:string;received_at:string};
type ReceiptRow={sequence:number;user_id:string;library_id:string;receipt_id:string;summary_id:string;status:string;payload_hash:string;payload_json:string;writer_grant_id:string;received_at:string};
export type StoredAssistance={sequence:number;record:AccountAssistanceV1;receivedAt:string};
export type StoredAssistanceReceipt={sequence:number;receipt:AssistanceReceiptV1;writerGrantId:string;receivedAt:string};
type Table='account_study_assistance'|'account_study_assistance_receipts';
function args(scope:StudyScope):[string,string]{studyObject(scope,['userId','libraryId']);studyId(scope.userId,'user');studyId(scope.libraryId,'library');return[scope.userId,scope.libraryId];}
/** Only appends auxiliary evidence. No V3, score or mastery projection writes. */
export class AccountAssistanceStore{
  private database:Pick<D1Database,'prepare'>;
  private clock:()=>Date;
  constructor(database:Pick<D1Database,'prepare'>,clock:()=>Date=()=>new Date()){this.database=database;this.clock=clock;}
  private q(sql:string,...values:(string|number)[]){return this.database.prepare(sql).bind(...values);}
  async supported():Promise<boolean>{return(await this.q("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('account_study_assistance','account_study_assistance_receipts')").first<number>('n'))===2;}
  async readFences(scope:StudyScope):Promise<{summaries:number;receipts:number}>{
    return await this.q('SELECT (SELECT coalesce(max(sequence),0) FROM account_study_assistance WHERE user_id=? AND library_id=?) AS summaries, (SELECT coalesce(max(sequence),0) FROM account_study_assistance_receipts WHERE user_id=? AND library_id=?) AS receipts',...args(scope),...args(scope)).first<{summaries:number;receipts:number}>()??{summaries:0,receipts:0};
  }
  private async parent(scope:StudyScope,eventId:string):Promise<StudyRecordEnvelope>{
    const row=await this.q('SELECT core_hash,envelope_hash,record_json FROM account_study_records WHERE user_id=? AND library_id=? AND event_id=?',...args(scope),eventId).first<{core_hash:string;envelope_hash:string;record_json:string}>();
    if(!row)throw new Error('unknown-study-record');const record=await parseStudyRecord(JSON.parse(row.record_json));
    if(record.libraryId!==scope.libraryId||record.event.eventId!==eventId||record.event.coreHash!==row.core_hash||record.envelopeHash!==row.envelope_hash)throw new Error('study-record-integrity');return record;
  }
  private async wire(scope:StudyScope,row:SummaryRow):Promise<StoredAssistance>{
    const record=await parseAccountAssistance(JSON.parse(row.record_json));
    if(row.user_id!==scope.userId||row.library_id!==scope.libraryId||record.libraryId!==scope.libraryId||row.event_id!==record.summary.attemptEventId||row.summary_id!==record.summary.summaryId||row.summary_hash!==record.summary.summaryHash||row.association_hash!==record.associationHash)throw new Error('assistance-storage-integrity');
    await validateAccountAssistance(record,await this.parent(scope,row.event_id));return{sequence:row.sequence,record,receivedAt:row.received_at};
  }
  async get(scope:StudyScope,summaryId:string):Promise<StoredAssistance|null>{studyId(summaryId,'summary');const row=await this.q('SELECT * FROM account_study_assistance WHERE user_id=? AND library_id=? AND summary_id=?',...args(scope),summaryId).first<SummaryRow>();return row?this.wire(scope,row):null;}
  async append(scope:StudyScope,raw:unknown):Promise<{status:'accepted'|'duplicate'|'conflict';durable:boolean;sequence:number;summaryId:string;summaryHash:string;associationHash:string}>{
    args(scope);const record=await parseAccountAssistance(raw),s=record.summary;
    if(record.libraryId!==scope.libraryId)throw new Error('study-scope-mismatch');
    await validateAccountAssistance(record,await this.parent(scope,s.attemptEventId));
    const inserted=await this.q('INSERT INTO account_study_assistance(user_id,library_id,summary_id,event_id,summary_hash,association_hash,record_json,received_at) SELECT ?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM account_study_records WHERE user_id=? AND library_id=? AND event_id=? AND envelope_hash=? AND core_hash=?) ON CONFLICT DO NOTHING RETURNING sequence',
      ...args(scope),s.summaryId,s.attemptEventId,s.summaryHash,record.associationHash,canonicalizeJson(record),this.clock().toISOString(),...args(scope),s.attemptEventId,record.attemptEnvelopeHash,s.attemptCoreHash).all<{sequence:number}>();
    const row=await this.q('SELECT * FROM account_study_assistance WHERE user_id=? AND library_id=? AND event_id=?',...args(scope),s.attemptEventId).first<SummaryRow>();
    if(!row)throw new Error('assistance-storage-failed');const saved=await this.wire(scope,row);
    const same=saved.record.associationHash===record.associationHash;
    return{status:!same?'conflict':inserted.results.length?'accepted':'duplicate',durable:same,sequence:row.sequence,summaryId:s.summaryId,summaryHash:saved.record.summary.summaryHash,associationHash:saved.record.associationHash};
  }
  private async page<T extends SummaryRow|ReceiptRow>(scope:StudyScope,table:Table,after:number,limit:number,through?:number):Promise<{rows:T[];through:number;more:boolean}>{
    studyCount(after,'assistance-cursor');studyCount(limit,'assistance-limit',1);if(limit>20)throw new Error('invalid-assistance-limit');
    const latest=await this.q(`SELECT coalesce(max(sequence),0) AS cursor FROM ${table} WHERE user_id=? AND library_id=?`,...args(scope)).first<number>('cursor')??0;
    const fence=through??latest;studyCount(fence,'assistance-fence');if(after>fence||fence>latest)throw new Error('invalid-assistance-fence');
    if(fence&&!await this.q(`SELECT sequence FROM ${table} WHERE user_id=? AND library_id=? AND sequence=?`,...args(scope),fence).first())throw new Error('invalid-assistance-fence');
    const rows=(await this.q(`SELECT * FROM ${table} WHERE user_id=? AND library_id=? AND sequence>? AND sequence<=? ORDER BY sequence LIMIT ?`,...args(scope),after,fence,limit+1).all<T>()).results;
    if(rows.length<=limit&&(rows.at(-1)?.sequence??after)!==fence)throw new Error('invalid-assistance-fence');return{rows:rows.slice(0,limit),through:fence,more:rows.length>limit};
  }
  async listAfter(scope:StudyScope,after:number,limit:number,through?:number):Promise<{summaries:StoredAssistance[];nextCursor:number|null;through:number}>{
    const page=await this.page<SummaryRow>(scope,'account_study_assistance',after,limit,through),summaries:StoredAssistance[]=[];
    for(const row of page.rows)summaries.push(await this.wire(scope,row));return{summaries,nextCursor:page.more?summaries.at(-1)!.sequence:null,through:page.through};
  }
  private async writer(scope:StudyScope,grantId:string,now:string){studyId(grantId,'writer');return Boolean(await this.q("SELECT grant_id FROM account_study_grants WHERE user_id=? AND library_id=? AND grant_id=? AND state='active' AND expires_at>?",...args(scope),grantId,now).first());}
  private async wireReceipt(scope:StudyScope,row:ReceiptRow):Promise<StoredAssistanceReceipt>{
    const receipt=parseAssistanceReceipt(JSON.parse(row.payload_json)),parent=await this.get(scope,row.summary_id);
    if(!parent||row.user_id!==scope.userId||row.library_id!==scope.libraryId||row.receipt_id!==receipt.receiptId||row.summary_id!==receipt.summaryId||row.status!==receipt.status||await studyHash(receipt)!==row.payload_hash)throw new Error('assistance-receipt-integrity');
    checkAssistanceReceipt(parent.record,receipt);return{sequence:row.sequence,receipt,writerGrantId:row.writer_grant_id,receivedAt:row.received_at};
  }
  private async latest(scope:StudyScope,summaryId:string):Promise<ReceiptRow|null>{return this.q('SELECT * FROM account_study_assistance_receipts WHERE user_id=? AND library_id=? AND summary_id=? ORDER BY sequence DESC LIMIT 1',...args(scope),summaryId).first<ReceiptRow>();}
  async appendReceipt(scope:StudyScope,raw:unknown,grantId:string):Promise<{status:'accepted'|'duplicate'|'conflict';receipt:StoredAssistanceReceipt}>{
    const receipt=parseAssistanceReceipt(raw),now=this.clock().toISOString();
    if(!await this.writer(scope,grantId,now))throw new Error('study-writer-required');
    const parent=await this.get(scope,receipt.summaryId);if(!parent)throw new Error('unknown-assistance-summary');checkAssistanceReceipt(parent.record,receipt);
    const hash=await studyHash(receipt),prior=await this.q('SELECT * FROM account_study_assistance_receipts WHERE user_id=? AND library_id=? AND receipt_id=?',...args(scope),receipt.receiptId).first<ReceiptRow>();
    if(prior)return{status:prior.payload_hash===hash?'duplicate':'conflict',receipt:await this.wireReceipt(scope,prior)};
    const latest=await this.latest(scope,receipt.summaryId);
    if(latest?.status==='applied'){const saved=await this.wireReceipt(scope,latest);if(receipt.status!=='applied'||canonicalizeJson(receipt.proof)!==canonicalizeJson(saved.receipt.proof))return{status:'conflict',receipt:saved};}
    // Atomic last check protects revocation and terminal evidence between awaits.
    const inserted=await this.q("INSERT INTO account_study_assistance_receipts(user_id,library_id,receipt_id,summary_id,status,payload_hash,payload_json,writer_grant_id,received_at) SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM account_study_grants WHERE user_id=? AND library_id=? AND grant_id=? AND state='active' AND expires_at>?) AND NOT EXISTS (SELECT 1 FROM account_study_assistance_receipts WHERE user_id=? AND library_id=? AND summary_id=? AND status='applied' AND (?!='applied' OR json_extract(payload_json,'$.proof')!=json_extract(?,'$.proof'))) ON CONFLICT DO NOTHING RETURNING sequence",
      ...args(scope),receipt.receiptId,receipt.summaryId,receipt.status,hash,canonicalizeJson(receipt),grantId,now,...args(scope),grantId,now,...args(scope),receipt.summaryId,receipt.status,canonicalizeJson(receipt)).all<{sequence:number}>();
    const row=await this.q('SELECT * FROM account_study_assistance_receipts WHERE user_id=? AND library_id=? AND receipt_id=?',...args(scope),receipt.receiptId).first<ReceiptRow>();
    if(row)return{status:row.payload_hash!==hash?'conflict':inserted.results.length?'accepted':'duplicate',receipt:await this.wireReceipt(scope,row)};
    if(!await this.writer(scope,grantId,now))throw new Error('study-writer-required');
    const current=await this.latest(scope,receipt.summaryId);if(current?.status==='applied')return{status:'conflict',receipt:await this.wireReceipt(scope,current)};
    throw new Error('assistance-receipt-storage-failed');
  }
  async listReceiptsAfter(scope:StudyScope,after:number,limit:number,through?:number):Promise<{receipts:StoredAssistanceReceipt[];nextCursor:number|null;through:number}>{
    const page=await this.page<ReceiptRow>(scope,'account_study_assistance_receipts',after,limit,through),receipts:StoredAssistanceReceipt[]=[];
    for(const row of page.rows)receipts.push(await this.wireReceipt(scope,row));return{receipts,nextCursor:page.more?receipts.at(-1)!.sequence:null,through:page.through};
  }
}
