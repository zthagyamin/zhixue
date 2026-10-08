import type {StudyScope} from './account-study-store';
import type {MachineWritebackReceipt} from '../app/account-study-receipt';
import type {StudyDeliveryReceipt} from '../app/local-account-study';
// @ts-expect-error TS5097: Node tests use explicit TypeScript extensions.
import {parseWritebackReceipt} from '../app/account-study-receipt.ts';
// @ts-expect-error TS5097: Node tests use explicit TypeScript extensions.
import {parseStudyRecord} from '../app/account-study-record.ts';
// @ts-expect-error TS5097: Node tests use explicit TypeScript extensions.
import {studyObject,studyId,studyCount,studyHash} from '../app/account-study-content.ts';
// @ts-expect-error TS5097: Node tests use explicit TypeScript extensions.
import {canonicalizeJson} from '../app/study-event-v3.ts';

type ReceiptRow={sequence:number;user_id:string;library_id:string;receipt_id:string;event_id:string;envelope_hash:string;status:string;
  payload_hash:string;payload_json:string;writer_grant_id:string;received_at:string};
export type StoredWritebackReceipt={sequence:number;receipt:MachineWritebackReceipt;delivery:StudyDeliveryReceipt;receivedAt:string;writerGrantId:string};
type AppendResult={status:'accepted'|'duplicate';receipt:StoredWritebackReceipt}|{status:'conflict';current:StoredWritebackReceipt};
function args(scope:StudyScope):[string,string]{studyObject(scope,['userId','libraryId']);studyId(scope.userId,'user');studyId(scope.libraryId,'library');return [scope.userId,scope.libraryId];}
export class AccountStudyReceiptStore {
  private database:Pick<D1Database,'prepare'>;
  private clock:()=>Date;
  constructor(database:Pick<D1Database,'prepare'>,clock:()=>Date=()=>new Date()){this.database=database;this.clock=clock;}
  private q(query:string,...values:(string|number)[]):D1PreparedStatement{return this.database.prepare(query).bind(...values);}
  private async writer(scope:StudyScope,grantId:string,now:string):Promise<boolean>{studyId(grantId,'writer');
    return Boolean(await this.q("SELECT grant_id FROM account_study_grants WHERE user_id=? AND library_id=? AND grant_id=? AND state='active' AND expires_at>?",...args(scope),grantId,now).first());}
  private async parent(scope:StudyScope,eventId:string):Promise<{coreHash:string;envelopeHash:string}> {
    const row=await this.q('SELECT core_hash,envelope_hash,record_json FROM account_study_records WHERE user_id=? AND library_id=? AND event_id=?',...args(scope),eventId)
      .first<{core_hash:string;envelope_hash:string;record_json:string}>();
    if(!row) throw new Error('unknown-study-record');
    const record=await parseStudyRecord(JSON.parse(row.record_json));
    if(record.libraryId!==scope.libraryId||record.event.eventId!==eventId||record.event.coreHash!==row.core_hash||record.envelopeHash!==row.envelope_hash) throw new Error('study-record-integrity');
    return {coreHash:row.core_hash,envelopeHash:row.envelope_hash};
  }
  private async wire(scope:StudyScope,row:ReceiptRow):Promise<StoredWritebackReceipt> {
    const receipt=parseWritebackReceipt(JSON.parse(row.payload_json));
    if(row.user_id!==scope.userId||row.library_id!==scope.libraryId||row.receipt_id!==receipt.receiptId||row.event_id!==receipt.eventId
      ||row.envelope_hash!==receipt.envelopeHash||row.status!==receipt.status||await studyHash(receipt)!==row.payload_hash) throw new Error('study-receipt-integrity');
    const parent=await this.parent(scope,receipt.eventId);
    if(parent.envelopeHash!==receipt.envelopeHash||(receipt.proof&&receipt.proof.coreHash!==parent.coreHash)) throw new Error('study-receipt-integrity');
    return {sequence:row.sequence,receipt,receivedAt:row.received_at,writerGrantId:row.writer_grant_id,
      delivery:{schemaVersion:1,libraryId:scope.libraryId,eventId:receipt.eventId,envelopeHash:receipt.envelopeHash,target:'companion',
        status:receipt.status,revision:row.sequence,...(receipt.reason===undefined?{}:{reason:receipt.reason})}};
  }
  private async latest(scope:StudyScope,eventId:string):Promise<StoredWritebackReceipt|null> {
    const row=await this.q('SELECT * FROM account_study_writeback_receipts WHERE user_id=? AND library_id=? AND event_id=? ORDER BY sequence DESC LIMIT 1',...args(scope),eventId).first<ReceiptRow>();
    return row?this.wire(scope,row):null;
  }
  async append(scope:StudyScope,raw:unknown,writerGrantId:string):Promise<AppendResult> {
    args(scope);const receipt=parseWritebackReceipt(raw),now=this.clock().toISOString();
    if(!await this.writer(scope,writerGrantId,now)) throw new Error('study-writer-required');
    const parent=await this.parent(scope,receipt.eventId);
    if(parent.envelopeHash!==receipt.envelopeHash||(receipt.proof&&receipt.proof.coreHash!==parent.coreHash)) throw new Error('study-receipt-binding');
    const hash=await studyHash(receipt);
    const existing=await this.q('SELECT * FROM account_study_writeback_receipts WHERE user_id=? AND library_id=? AND receipt_id=?',...args(scope),receipt.receiptId).first<ReceiptRow>();
    if(existing){const stored=await this.wire(scope,existing);return existing.payload_hash===hash?{status:'duplicate',receipt:stored}:{status:'conflict',current:stored};}
    const before=await this.latest(scope,receipt.eventId);
    if(before?.receipt.status==='applied'&&receipt.status!=='applied') return {status:'conflict',current:before};
    const inserted=await this.q("INSERT INTO account_study_writeback_receipts(user_id,library_id,receipt_id,event_id,envelope_hash,status,payload_hash,payload_json,writer_grant_id,received_at) SELECT ?,?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM account_study_grants WHERE user_id=? AND library_id=? AND grant_id=? AND state='active' AND expires_at>?) AND (?='applied' OR NOT EXISTS (SELECT 1 FROM account_study_writeback_receipts WHERE user_id=? AND library_id=? AND event_id=? AND status='applied')) ON CONFLICT DO NOTHING RETURNING sequence",
      ...args(scope),receipt.receiptId,receipt.eventId,receipt.envelopeHash,receipt.status,hash,canonicalizeJson(receipt),writerGrantId,now,
      ...args(scope),writerGrantId,now,receipt.status,...args(scope),receipt.eventId).all<{sequence:number}>();
    const saved=await this.q('SELECT * FROM account_study_writeback_receipts WHERE user_id=? AND library_id=? AND receipt_id=?',...args(scope),receipt.receiptId).first<ReceiptRow>();
    if(saved){const stored=await this.wire(scope,saved);if(saved.payload_hash!==hash) return {status:'conflict',current:stored};
      return {status:inserted.results.length?'accepted':'duplicate',receipt:stored};}
    const current=await this.latest(scope,receipt.eventId);
    if(current?.receipt.status==='applied'&&receipt.status!=='applied') return {status:'conflict',current};
    if(!await this.writer(scope,writerGrantId,now)) throw new Error('study-writer-required');
    throw new Error('study-receipt-storage-failed');
  }
  async listAfter(scope:StudyScope,after:number,limit:number,through?:number):Promise<{receipts:StoredWritebackReceipt[];nextCursor:number|null;through:number}> {
    studyCount(after,'receipt-cursor');studyCount(limit,'receipt-limit',1);if(limit>20) throw new Error('invalid-receipt-limit');
    const latest=await this.q('SELECT coalesce(max(sequence),0) AS cursor FROM account_study_writeback_receipts WHERE user_id=? AND library_id=?',...args(scope)).first<number>('cursor')??0;
    const fence=through??latest;studyCount(fence,'receipt-fence');if(after>fence||fence>latest) throw new Error('invalid-receipt-fence');
    if(fence!==0&&!await this.q('SELECT sequence FROM account_study_writeback_receipts WHERE user_id=? AND library_id=? AND sequence=?',...args(scope),fence).first()) throw new Error('invalid-receipt-fence');
    const rows=(await this.q('SELECT * FROM account_study_writeback_receipts WHERE user_id=? AND library_id=? AND sequence>? AND sequence<=? ORDER BY sequence LIMIT ?',...args(scope),after,fence,limit+1).all<ReceiptRow>()).results;
    const receipts:StoredWritebackReceipt[]=[];
    // Keep DB validation bounded and sequential; D1 has a per-invocation
    // concurrent connection limit, so do not fan out 20 parent lookups at once.
    for(const row of rows.slice(0,limit)) receipts.push(await this.wire(scope,row));
    if(rows.length<=limit&&(receipts.at(-1)?.sequence??after)!==fence) throw new Error('invalid-receipt-fence');
    return {receipts,nextCursor:rows.length>limit?receipts.at(-1)!.sequence:null,through:fence};
  }
}
