import type {StudySnapshot,StudyItemVersion} from '../app/account-study-content';
import type {StudyRecordEnvelope} from '../app/account-study-record';
// @ts-expect-error TS5097: Node tests use explicit TypeScript extensions.
import {parseStudySnapshot,parseStudyItem,validateStudyBundle,studyObject,studyId,studyDigest,studyCount,studyHash} from '../app/account-study-content.ts';
// @ts-expect-error TS5097: Node tests use explicit TypeScript extensions.
import {parseStudyRecord,compareStudyRecord,checkStudyRecordBinding} from '../app/account-study-record.ts';
// @ts-expect-error TS5097: Node tests use explicit TypeScript extensions.
import {canonicalizeJson} from '../app/study-event-v3.ts';
// @ts-expect-error TS5097: Node tests use explicit TypeScript extensions.
import {requireCourseFormalProof} from '../src/infrastructure/course-proof/index.ts';
// @ts-expect-error TS5097: Node tests use explicit TypeScript extensions.
import {evaluationFingerprint} from '../src/infrastructure/learning-attempt/fingerprint.ts';

export type StudyScope={userId:string;libraryId:string};
type Metadata={user_id:string;library_id:string;snapshot_id:string;revision:number;snapshot_hash:string;
  header_json:string;member_count:number;published:number};
type Member={position:number;item_key:string;content_hash:string;item_json?:string};
type ManifestPage={page:number;page_hash:string;page_json:string};
type RecordRow={sequence:number;user_id:string;library_id:string;event_id:string;snapshot_id:string;core_hash:string;envelope_hash:string;record_json:string};
type SnapshotResult={status:'accepted'|'duplicate'|'stale';revision:number};
export type StoredStudyRecord={sequence:number;record:StudyRecordEnvelope};
const PAGE_ITEMS=20;
const MEMBER_PAGE=1000;
const MAX_MEMBERS=10000;
const MANIFEST_PAGE=500;

function scopeArgs(scope:StudyScope):[string,string] {
  studyObject(scope,['userId','libraryId']);studyId(scope.userId,'user');studyId(scope.libraryId,'library');
  return [scope.userId,scope.libraryId];
}
function scopedSnapshot(scope:StudyScope,snapshot:StudySnapshot):void {
  scopeArgs(scope);if(scope.libraryId!==snapshot.libraryId) throw new Error('study-scope-mismatch');
}
function headerJson(snapshot:StudySnapshot):string {
  const header:Partial<StudySnapshot>={...snapshot};delete header.items;delete header.snapshotHash;return canonicalizeJson(header);
}

/** Persistence only. Accepted records still need causal/plan validation and
 * authenticated Companion execution before they affect any learning projection. */
export class AccountStudyStore {
  private database:Pick<D1Database,'prepare'|'batch'>;
  constructor(database:Pick<D1Database,'prepare'|'batch'>){this.database=database;}
  private q(query:string,...values:(string|number|null)[]):D1PreparedStatement{return this.database.prepare(query).bind(...values);}
  private async metadata(scope:StudyScope,id:string):Promise<Metadata|null> {
    studyId(id,'snapshot');return this.q('SELECT * FROM account_study_snapshots WHERE user_id=? AND library_id=? AND snapshot_id=?',...scopeArgs(scope),id).first<Metadata>();
  }
  private async head(scope:StudyScope):Promise<{snapshot_id:string|null;revision:number}> {
    return await this.q('SELECT snapshot_id,revision FROM account_study_heads WHERE user_id=? AND library_id=?',...scopeArgs(scope))
      .first<{snapshot_id:string|null;revision:number}>()??{snapshot_id:null,revision:0};
  }
  async beginSnapshot(scope:StudyScope,raw:unknown):Promise<void> {
    const snapshot=await parseStudySnapshot(raw);scopedSnapshot(scope,snapshot);
    const args=scopeArgs(scope),header=headerJson(snapshot);
    const pages:ManifestPage[]=[];
    for(let offset=0;offset<snapshot.items.length;offset+=MANIFEST_PAGE) {
      const refs=snapshot.items.slice(offset,offset+MANIFEST_PAGE);
      pages.push({page:offset/MANIFEST_PAGE,page_hash:await studyHash(refs),page_json:canonicalizeJson(refs)});
    }
    const queries=[
      this.q('INSERT INTO account_study_libraries(user_id,library_id) VALUES (?,?) ON CONFLICT DO NOTHING',...args),
      this.q('INSERT INTO account_study_heads(user_id,library_id,revision) VALUES (?,?,0) ON CONFLICT DO NOTHING',...args),
      this.q('INSERT INTO account_study_snapshots(user_id,library_id,snapshot_id,revision,snapshot_hash,header_json,member_count,published) VALUES (?,?,?,?,?,?,?,0) ON CONFLICT DO NOTHING',
        ...args,snapshot.snapshotId,snapshot.revision,snapshot.snapshotHash,header,snapshot.items.length),
    ];
    for(const page of pages) queries.push(this.q('INSERT INTO account_study_manifest_pages(user_id,library_id,snapshot_id,page,page_hash,page_json) SELECT ?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM account_study_snapshots WHERE user_id=? AND library_id=? AND snapshot_id=? AND snapshot_hash=?) ON CONFLICT DO NOTHING',
      ...args,snapshot.snapshotId,page.page,page.page_hash,page.page_json,...args,snapshot.snapshotId,snapshot.snapshotHash));
    await this.database.batch(queries);
    const saved=await this.metadata(scope,snapshot.snapshotId);
    if(!saved) throw new Error('study-storage-missing-snapshot');
    if(saved.snapshot_hash!==snapshot.snapshotHash||saved.member_count!==snapshot.items.length||saved.revision!==snapshot.revision
      ||canonicalizeJson(JSON.parse(saved.header_json))!==header) throw new Error('study-snapshot-conflict');
    const stored=await this.manifestRows(scope,snapshot.snapshotId);
    if(stored.length!==pages.length||stored.some((page,i)=>page.page!==pages[i].page||page.page_hash!==pages[i].page_hash
      ||page.page_json!==pages[i].page_json)) throw new Error('study-manifest-integrity');
  }
  private async manifestRows(scope:StudyScope,id:string,pages?:number[]):Promise<ManifestPage[]> {
    const clause=pages===undefined?'':` AND page IN (${pages.map(()=>'?').join(',')})`;
    return (await this.q(`SELECT page,page_hash,page_json FROM account_study_manifest_pages WHERE user_id=? AND library_id=? AND snapshot_id=?${clause} ORDER BY page LIMIT 21`,
      ...scopeArgs(scope),id,...(pages??[])).all<ManifestPage>()).results;
  }
  private async positionRows(scope:StudyScope,id:string,positions:number[]):Promise<Member[]> {
    return (await this.q(`SELECT m.position,m.item_key,m.content_hash,v.item_json FROM account_study_snapshot_members m JOIN account_study_item_versions v ON v.user_id=m.user_id AND v.library_id=m.library_id AND v.item_key=m.item_key AND v.content_hash=m.content_hash WHERE m.user_id=? AND m.library_id=? AND m.snapshot_id=? AND m.position IN (${positions.map(()=>'?').join(',')})`,
      ...scopeArgs(scope),id,...positions).all<Member>()).results;
  }
  private async checkPositions(rows:Member[],entries:{position:number;item:StudyItemVersion}[],allowMissing:boolean):Promise<void> {
    const byPosition=new Map(rows.map(row=>[row.position,row]));
    for(const entry of entries) {
      const row=byPosition.get(entry.position);if(!row&&allowMissing) continue;
      if(!row||row.item_key!==entry.item.itemKey||row.content_hash!==entry.item.contentHash||!row.item_json) throw new Error('study-member-conflict');
      if(canonicalizeJson(await parseStudyItem(JSON.parse(row.item_json)))!==canonicalizeJson(entry.item)) throw new Error('study-content-integrity');
    }
  }
  private async memberRows(scope:StudyScope,id:string,start:number,limit:number,withContent:boolean):Promise<Member[]> {
    const query=withContent
      ? 'SELECT m.position,m.item_key,m.content_hash,v.item_json FROM account_study_snapshot_members m JOIN account_study_item_versions v ON v.user_id=m.user_id AND v.library_id=m.library_id AND v.item_key=m.item_key AND v.content_hash=m.content_hash WHERE m.user_id=? AND m.library_id=? AND m.snapshot_id=? AND m.position>=? ORDER BY m.position LIMIT ?'
      : 'SELECT position,item_key,content_hash FROM account_study_snapshot_members WHERE user_id=? AND library_id=? AND snapshot_id=? AND position>=? ORDER BY position LIMIT ?';
    return (await this.q(query,...scopeArgs(scope),id,start,limit).all<Member>()).results;
  }
  async stageSnapshotItems(scope:StudyScope,id:string,raw:unknown):Promise<void> {
    scopeArgs(scope);const meta=await this.metadata(scope,id);
    if(!meta) throw new Error('unknown-study-snapshot');
    if(!Array.isArray(raw)||raw.length<1||raw.length>PAGE_ITEMS) throw new Error('invalid-study-upload-page');
    const entries:{position:number;item:StudyItemVersion}[]=[],positions=new Set<number>();
    for(const value of raw) {
      const entry=studyObject(value,['position','item']);studyCount(entry.position,'position');
      if(entry.position>=meta.member_count||positions.has(entry.position)) throw new Error('invalid-study-member-position');
      positions.add(entry.position);entries.push({position:entry.position,item:await parseStudyItem(entry.item)});
    }
    const expected=new Map<number,{itemKey:string;contentHash:string}[]>();
    const neededPages=[...new Set(entries.map(entry=>Math.floor(entry.position/MANIFEST_PAGE)))];
    for(const row of await this.manifestRows(scope,id,neededPages)) {
      const refs:unknown=JSON.parse(row.page_json);
      if(!Array.isArray(refs)||refs.length>MANIFEST_PAGE) throw new Error('study-manifest-integrity');
      for(const ref of refs){const value=studyObject(ref,['itemKey','contentHash']);studyId(value.itemKey);studyDigest(value.contentHash);}
      if(await studyHash(refs)!==row.page_hash) throw new Error('study-manifest-integrity');
      expected.set(row.page,refs as {itemKey:string;contentHash:string}[]);
    }
    for(const {position,item} of entries) {
      const ref=expected.get(Math.floor(position/MANIFEST_PAGE))?.[position%MANIFEST_PAGE];
      if(!ref||ref.itemKey!==item.itemKey||ref.contentHash!==item.contentHash) throw new Error('study-manifest-member-mismatch');
    }
    await this.checkPositions(await this.positionRows(scope,id,entries.map(entry=>entry.position)),entries,meta.published!==1);
    if(meta.published!==1) {
      const queries:D1PreparedStatement[]=[];
      for(const {position,item} of entries) {
        queries.push(this.q('INSERT INTO account_study_item_versions(user_id,library_id,item_key,content_hash,item_json) VALUES (?,?,?,?,?) ON CONFLICT DO NOTHING',
          ...scopeArgs(scope),item.itemKey,item.contentHash,canonicalizeJson(item)));
        queries.push(this.q('INSERT INTO account_study_snapshot_members(user_id,library_id,snapshot_id,position,item_key,content_hash) VALUES (?,?,?,?,?,?) ON CONFLICT DO NOTHING',
          ...scopeArgs(scope),id,position,item.itemKey,item.contentHash));
      }
      await this.database.batch(queries);
    }
    await this.checkPositions(await this.positionRows(scope,id,entries.map(entry=>entry.position)),entries,false);
  }
  private async readManifest(scope:StudyScope,id:string,staging:boolean):Promise<StudySnapshot|null> {
    const meta=await this.metadata(scope,id);if(!meta||(!staging&&meta.published!==1)) return null;
    studyCount(meta.member_count,'member-count');if(meta.member_count>MAX_MEMBERS) throw new Error('invalid-study-member-count');
    const count=await this.q('SELECT count(*) AS n FROM account_study_snapshot_members WHERE user_id=? AND library_id=? AND snapshot_id=?',...scopeArgs(scope),id).first<number>('n');
    if(count!==meta.member_count) throw new Error('incomplete-study-snapshot');
    const items:{itemKey:string;contentHash:string}[]=[];
    for(let start=0;start<meta.member_count;start+=MEMBER_PAGE) {
      const rows=await this.memberRows(scope,id,start,MEMBER_PAGE,false);
      if(rows.length!==Math.min(MEMBER_PAGE,meta.member_count-start)) throw new Error('incomplete-study-snapshot');
      rows.forEach((row,index)=>{if(row.position!==start+index) throw new Error('incomplete-study-snapshot');items.push({itemKey:row.item_key,contentHash:row.content_hash});});
    }
    const snapshot=await parseStudySnapshot({...JSON.parse(meta.header_json),items,snapshotHash:meta.snapshot_hash});
    if(snapshot.libraryId!==scope.libraryId||snapshot.snapshotId!==id||snapshot.revision!==meta.revision) throw new Error('study-snapshot-integrity');
    return snapshot;
  }
  async completeSnapshot(scope:StudyScope,id:string,expectedRevision:number):Promise<SnapshotResult> {
    studyCount(expectedRevision,'expected-revision');const snapshot=await this.readManifest(scope,id,true);
    if(!snapshot) throw new Error('unknown-study-snapshot');
    const before=await this.metadata(scope,id);
    if(before?.published===1) return {status:'duplicate',revision:(await this.head(scope)).revision};
    if(snapshot.revision!==expectedRevision+1) throw new Error('invalid-study-publication-revision');
    await this.database.batch([
      this.q('UPDATE account_study_heads SET snapshot_id=?,revision=? WHERE user_id=? AND library_id=? AND revision=?',id,snapshot.revision,...scopeArgs(scope),expectedRevision),
      this.q('UPDATE account_study_snapshots SET published=1 WHERE user_id=? AND library_id=? AND snapshot_id=? AND EXISTS (SELECT 1 FROM account_study_heads h WHERE h.user_id=? AND h.library_id=? AND h.snapshot_id=? AND h.revision=?)',
        ...scopeArgs(scope),id,...scopeArgs(scope),id,snapshot.revision),
    ]);
    const after=await this.metadata(scope,id),head=await this.head(scope);
    if(after?.published===1) return {status:'accepted',revision:head.revision};
    if(head.revision!==expectedRevision) return {status:'stale',revision:head.revision};
    throw new Error('study-storage-publication-failed');
  }
  /** Small-bundle fast path. Larger libraries use separate bounded requests
   * for beginSnapshot, stageSnapshotItems and completeSnapshot. */
  async putSnapshot(scope:StudyScope,raw:unknown,expectedRevision:number):Promise<SnapshotResult> {
    const bundle=await validateStudyBundle(raw);scopedSnapshot(scope,bundle.snapshot);
    if(bundle.items.length>10) throw new Error('use-staged-snapshot-upload');
    await this.beginSnapshot(scope,bundle.snapshot);
    if(bundle.items.length) await this.stageSnapshotItems(scope,bundle.snapshot.snapshotId,bundle.items.map((item,position)=>({item,position})));
    return this.completeSnapshot(scope,bundle.snapshot.snapshotId,expectedRevision);
  }
  async getSnapshot(scope:StudyScope,snapshotId?:string):Promise<StudySnapshot|null> {
    scopeArgs(scope);const id=snapshotId??(await this.head(scope)).snapshot_id;
    return id===null?null:this.readManifest(scope,id,false);
  }
  async getSnapshotItems(scope:StudyScope,id:string,afterPosition=0,limit=PAGE_ITEMS):Promise<{items:StudyItemVersion[];nextPosition:number|null}> {
    studyCount(afterPosition,'position');studyCount(limit,'page-limit',1);if(limit>PAGE_ITEMS) throw new Error('invalid-study-page-limit');
    const meta=await this.metadata(scope,id);if(!meta||meta.published!==1) throw new Error('unknown-study-snapshot');
    if(afterPosition>meta.member_count) throw new Error('invalid-study-position');
    const rows=await this.memberRows(scope,id,afterPosition,limit,true);
    if(rows.length!==Math.min(limit,meta.member_count-afterPosition)) throw new Error('incomplete-study-content');
    const items:StudyItemVersion[]=[];
    for(const [index,row] of rows.entries()) {
      if(row.position!==afterPosition+index||!row.item_json) throw new Error('incomplete-study-content');
      const item=await parseStudyItem(JSON.parse(row.item_json));
      if(item.itemKey!==row.item_key||item.contentHash!==row.content_hash) throw new Error('study-content-integrity');items.push(item);
    }
    const next=afterPosition+items.length;return {items,nextPosition:next<meta.member_count?next:null};
  }
  async getSnapshotItem(scope:StudyScope,snapshotId:string,itemKey:string):Promise<StudyItemVersion|null>{scopeArgs(scope);studyId(snapshotId,'snapshot');studyId(itemKey,'item-key');const row=await this.q('SELECT v.item_json,m.content_hash FROM account_study_snapshot_members m JOIN account_study_item_versions v ON v.user_id=m.user_id AND v.library_id=m.library_id AND v.item_key=m.item_key AND v.content_hash=m.content_hash JOIN account_study_snapshots s ON s.user_id=m.user_id AND s.library_id=m.library_id AND s.snapshot_id=m.snapshot_id WHERE m.user_id=? AND m.library_id=? AND m.snapshot_id=? AND m.item_key=? AND s.published=1',...scopeArgs(scope),snapshotId,itemKey).first<{item_json:string;content_hash:string}>();if(!row)return null;const item=await parseStudyItem(JSON.parse(row.item_json));if(item.itemKey!==itemKey||item.contentHash!==row.content_hash)throw new Error('study-content-integrity');return item;}
  private async storedRecord(scope:StudyScope,id:string):Promise<RecordRow|null> {
    return this.q('SELECT * FROM account_study_records WHERE user_id=? AND library_id=? AND event_id=?',...scopeArgs(scope),id).first<RecordRow>();
  }
  private async recordFromRow(scope:StudyScope,row:RecordRow):Promise<StoredStudyRecord> {
    const record=await parseStudyRecord(JSON.parse(row.record_json));
    if(row.user_id!==scope.userId||row.library_id!==scope.libraryId||record.libraryId!==scope.libraryId||row.event_id!==record.event.eventId
      ||row.core_hash!==record.event.coreHash||row.envelope_hash!==record.envelopeHash||row.snapshot_id!==record.snapshotId) throw new Error('study-record-integrity');
    return {sequence:row.sequence,record};
  }
  async appendRecord(scope:StudyScope,raw:unknown):Promise<{status:'accepted'|'duplicate'|'conflict';sequence:number;durable:boolean}> {
    scopeArgs(scope);const record=await parseStudyRecord(raw);
    if(record.libraryId!==scope.libraryId) throw new Error('study-scope-mismatch');
    const old=await this.storedRecord(scope,record.event.eventId);
    if(old){const stored=await this.recordFromRow(scope,old),same=compareStudyRecord(stored.record,record)==='duplicate';
      return {status:same?'duplicate':'conflict',sequence:old.sequence,durable:same};}
    const snapshot=await this.metadata(scope,record.snapshotId);
    if(!snapshot||snapshot.published!==1) throw new Error('unknown-study-snapshot');
    if(record.provenanceMode!=='task') {
      const member=await this.q('SELECT v.item_json FROM account_study_snapshot_members m JOIN account_study_item_versions v ON v.user_id=m.user_id AND v.library_id=m.library_id AND v.item_key=m.item_key AND v.content_hash=m.content_hash WHERE m.user_id=? AND m.library_id=? AND m.snapshot_id=? AND m.item_key=? AND m.content_hash=?',
        ...scopeArgs(scope),record.snapshotId,record.event.item.key,record.contentHash).first<{item_json:string}>();
      if(!member) throw new Error('study-record-membership');const item=await parseStudyItem(JSON.parse(member.item_json));checkStudyRecordBinding(record,item);
      await requireCourseFormalProof(this.database,scope,item,record,evaluationFingerprint);
    }
    const inserted=await this.q('INSERT INTO account_study_records(user_id,library_id,event_id,snapshot_id,core_hash,envelope_hash,record_json) VALUES (?,?,?,?,?,?,?) ON CONFLICT DO NOTHING RETURNING sequence',
      ...scopeArgs(scope),record.event.eventId,record.snapshotId,record.event.coreHash,record.envelopeHash,canonicalizeJson(record)).all<{sequence:number}>();
    const saved=await this.storedRecord(scope,record.event.eventId);if(!saved) throw new Error('study-storage-missing-record');
    const checked=await this.recordFromRow(scope,saved),same=compareStudyRecord(checked.record,record)==='duplicate';
    return {status:!same?'conflict':inserted.results.length?'accepted':'duplicate',sequence:saved.sequence,durable:same};
  }
  async recordWatermark(scope:StudyScope):Promise<number> {
    const cursor=await this.q('SELECT coalesce(max(sequence),0) AS cursor FROM account_study_records WHERE user_id=? AND library_id=?',...scopeArgs(scope)).first<number>('cursor');
    studyCount(cursor,'stored-cursor');return cursor;
  }
  /** One SELECT sees all append-only streams at the same database boundary. */
  async readFences(scope:StudyScope):Promise<{records:number;operations:number;receipts:number;executions:number}>{
    const tables=['account_study_records','account_study_plan_operations','account_study_writeback_receipts','account_study_plan_execution_receipts'],names=['records','operations','receipts','executions'];
    const result=await this.q('SELECT '+tables.map((table,index)=>`(SELECT coalesce(max(sequence),0) FROM ${table} WHERE user_id=? AND library_id=?) AS ${names[index]}`).join(', '),...tables.flatMap(()=>scopeArgs(scope)))
      .first<{records:number;operations:number;receipts:number;executions:number}>();
    if(!result)throw new Error('study-read-fences-unavailable');for(const name of names)studyCount(result[name as keyof typeof result],'read-fence');return result;
  }
  async listRecordsAfter(scope:StudyScope,after:number,limit:number,through?:number):Promise<{records:StoredStudyRecord[];nextCursor:number|null;through:number}> {
    studyCount(after,'cursor');studyCount(limit,'page-limit',1);if(limit>20) throw new Error('invalid-study-page-limit');
    const latest=await this.recordWatermark(scope),fence=through??latest;
    studyCount(fence,'read-fence');if(after>fence||fence>latest) throw new Error('invalid-study-read-fence');
    if(fence!==0&&!await this.q('SELECT sequence FROM account_study_records WHERE user_id=? AND library_id=? AND sequence=?',...scopeArgs(scope),fence).first()) {
      throw new Error('invalid-study-read-fence');
    }
    const rows=(await this.q('SELECT * FROM account_study_records WHERE user_id=? AND library_id=? AND sequence>? AND sequence<=? ORDER BY sequence LIMIT ?',
      ...scopeArgs(scope),after,fence,limit+1).all<RecordRow>()).results;
    const records=await Promise.all(rows.slice(0,limit).map(row=>this.recordFromRow(scope,row)));
    if(rows.length<=limit&&(records.at(-1)?.sequence??after)!==fence) throw new Error('invalid-study-read-fence');
    return {records,nextCursor:rows.length>limit?records.at(-1)!.sequence:null,through:fence};
  }
}
