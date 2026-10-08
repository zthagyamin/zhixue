import type {StudyDevicePrincipal} from '../app/account-study-auth';
// @ts-expect-error TS5097: Node tests use explicit TypeScript extensions.
import {machineTokenHash} from '../app/account-study-auth.ts';
// @ts-expect-error TS5097: Node tests use explicit TypeScript extensions.
import {studyObject,studyId,studyDigest,studyCount,studyText,studyIso} from '../app/account-study-content.ts';

type Registration={grantId:string;libraryId:string;tokenHash:string;label:string;expectedProfileRevision:number;replaceLibrary:boolean};
type GrantRow={grant_id:string;user_id:string;library_id:string;token_hash:string;label:string;expected_profile_revision:number;
  replace_library:number;created_at:string;expires_at:string;state:string};
type Profile={libraryId:string|null;revision:number};
const GRANT_TTL_MS=30*24*60*60*1000;

function registration(raw:unknown):Registration {
  const value=studyObject(raw,['grantId','libraryId','tokenHash','label','expectedProfileRevision','replaceLibrary']);
  studyId(value.grantId,'grant');studyId(value.libraryId,'library');studyDigest(value.tokenHash);studyText(value.label,'device-label',80);
  studyCount(value.expectedProfileRevision,'profile-revision');if(typeof value.replaceLibrary!=='boolean') throw new Error('invalid-replace-library');
  return structuredClone(value) as Registration;
}
function matches(row:GrantRow,userId:string,input:Registration):boolean {
  return row.user_id===userId&&row.library_id===input.libraryId&&row.token_hash===input.tokenHash&&row.label===input.label
    &&row.expected_profile_revision===input.expectedProfileRevision&&row.replace_library===Number(input.replaceLibrary);
}
export class AccountStudyAccessStore {
  private database:Pick<D1Database,'prepare'|'batch'>;
  private clock:()=>Date;
  constructor(database:Pick<D1Database,'prepare'|'batch'>,clock:()=>Date=()=>new Date()){this.database=database;this.clock=clock;}
  private q(query:string,...values:(string|number|null)[]):D1PreparedStatement{return this.database.prepare(query).bind(...values);}
  private now():string {const value=this.clock().toISOString();studyIso(value);return value;}
  async profile(userId:string):Promise<Profile> {
    studyId(userId,'user');const row=await this.q('SELECT library_id,revision FROM account_study_profiles WHERE user_id=?',userId)
      .first<{library_id:string|null;revision:number}>();
    if(!row) return {libraryId:null,revision:0};studyCount(row.revision,'profile-revision');if(row.library_id!==null) studyId(row.library_id,'library');
    return {libraryId:row.library_id,revision:row.revision};
  }
  private async byHash(hash:string):Promise<GrantRow|null>{return this.q('SELECT * FROM account_study_grants WHERE token_hash=?',hash).first<GrantRow>();}
  private async pendingCount(userId:string,now:string):Promise<number>{return await this.q("SELECT count(*) AS n FROM account_study_grants WHERE user_id=? AND state='pending' AND expires_at>?",userId,now).first<number>('n')??0;}
  async register(userId:string,raw:unknown):Promise<{grantId:string;state:string;expiresAt:string}> {
    studyId(userId,'user');const input=registration(raw),now=this.now();
    const existing=await this.q('SELECT * FROM account_study_grants WHERE grant_id=?',input.grantId).first<GrantRow>();
    if(existing) {
      if(!matches(existing,userId,input)) throw new Error('study-grant-conflict');
      if(existing.expires_at<=now) throw new Error('study-grant-expired');
      return {grantId:existing.grant_id,state:existing.state,expiresAt:existing.expires_at};
    }
    if(await this.byHash(input.tokenHash)) throw new Error('study-grant-conflict');
    await this.database.batch([
      this.q('INSERT INTO learning_accounts(user_id) VALUES (?) ON CONFLICT DO NOTHING',userId),
      this.q('INSERT INTO account_study_profiles(user_id,revision) VALUES (?,0) ON CONFLICT DO NOTHING',userId),
    ]);
    const profile=await this.profile(userId);
    if(profile.revision!==input.expectedProfileRevision) throw new Error('study-grant-profile-conflict');
    if(profile.libraryId!==null&&profile.libraryId!==input.libraryId&&!input.replaceLibrary) throw new Error('study-replace-library-approval-required');
    if(await this.pendingCount(userId,now)>=5) throw new Error('study-grant-limit');
    const expiresAt=new Date(Date.parse(now)+GRANT_TTL_MS).toISOString();
    await this.database.batch([
      this.q("INSERT INTO account_study_libraries(user_id,library_id) SELECT ?,? WHERE EXISTS (SELECT 1 FROM account_study_profiles WHERE user_id=? AND revision=?) AND (SELECT count(*) FROM account_study_grants WHERE user_id=? AND state='pending' AND expires_at>?)<5 ON CONFLICT DO NOTHING",
        userId,input.libraryId,userId,input.expectedProfileRevision,userId,now),
      this.q("INSERT INTO account_study_grants(grant_id,user_id,library_id,token_hash,label,expected_profile_revision,replace_library,created_at,expires_at,state) SELECT ?,?,?,?,?,?,?,?,?,'pending' WHERE EXISTS (SELECT 1 FROM account_study_profiles WHERE user_id=? AND revision=? AND (library_id IS NULL OR library_id=? OR ?=1)) AND (SELECT count(*) FROM account_study_grants WHERE user_id=? AND state='pending' AND expires_at>?)<5 ON CONFLICT DO NOTHING",
        input.grantId,userId,input.libraryId,input.tokenHash,input.label,input.expectedProfileRevision,Number(input.replaceLibrary),now,expiresAt,
        userId,input.expectedProfileRevision,input.libraryId,Number(input.replaceLibrary),userId,now),
    ]);
    const saved=await this.q('SELECT * FROM account_study_grants WHERE grant_id=?',input.grantId).first<GrantRow>();
    if(!saved){
      if((await this.profile(userId)).revision!==input.expectedProfileRevision) throw new Error('study-grant-profile-conflict');
      if(await this.pendingCount(userId,now)>=5) throw new Error('study-grant-limit');
      throw new Error('study-grant-conflict');
    }
    if(!matches(saved,userId,input)) throw new Error('study-grant-conflict');
    return {grantId:saved.grant_id,state:saved.state,expiresAt:saved.expires_at};
  }
  async authenticate(secret:unknown):Promise<StudyDevicePrincipal|null> {
    let hash:string;
    try {hash=await machineTokenHash(secret);}catch(error){if(error instanceof Error&&error.message==='invalid-machine-token') return null;throw error;}
    const row=await this.byHash(hash),now=this.now();
    if(!row||!['pending','active'].includes(row.state)||row.expires_at<=now) return null;
    studyIso(row.expires_at);studyId(row.user_id,'user');studyId(row.library_id,'library');studyId(row.grant_id,'grant');
    if(row.state==='active'&&(await this.profile(row.user_id)).libraryId!==row.library_id) return null;
    return {kind:'device',userId:row.user_id,libraryId:row.library_id,grantId:row.grant_id,state:row.state as 'pending'|'active',expiresAt:row.expires_at};
  }
  async activate(secret:unknown):Promise<StudyDevicePrincipal> {
    const principal=await this.authenticate(secret);if(!principal) throw new Error('invalid-study-grant');
    if(principal.state==='active') return principal;
    const row=await this.byHash(await machineTokenHash(secret));if(!row) throw new Error('invalid-study-grant');
    const now=this.now();
    await this.database.batch([
      this.q("UPDATE account_study_grants SET state='active' WHERE grant_id=? AND token_hash=? AND state='pending' AND expires_at>? AND EXISTS (SELECT 1 FROM account_study_profiles WHERE user_id=? AND revision=? AND (library_id IS NULL OR library_id=? OR ?=1))",
        row.grant_id,row.token_hash,now,row.user_id,row.expected_profile_revision,row.library_id,row.replace_library),
      this.q("UPDATE account_study_profiles SET library_id=?,revision=revision+1 WHERE user_id=? AND revision=? AND EXISTS (SELECT 1 FROM account_study_grants WHERE grant_id=? AND token_hash=? AND state='active' AND expires_at>?)",
        row.library_id,row.user_id,row.expected_profile_revision,row.grant_id,row.token_hash,now),
      this.q("UPDATE account_study_grants SET state='revoked' WHERE user_id=? AND grant_id<>? AND state='active' AND EXISTS (SELECT 1 FROM account_study_profiles WHERE user_id=? AND library_id=? AND revision=?) AND EXISTS (SELECT 1 FROM account_study_grants WHERE grant_id=? AND token_hash=? AND state='active')",
        row.user_id,row.grant_id,row.user_id,row.library_id,row.expected_profile_revision+1,row.grant_id,row.token_hash),
    ]);
    const active=await this.authenticate(secret);if(!active||active.state!=='active') throw new Error('study-grant-profile-conflict');
    return active;
  }
  async revoke(userId:string,grantId:string):Promise<boolean> {
    studyId(userId,'user');studyId(grantId,'grant');
    const result=await this.q("UPDATE account_study_grants SET state='revoked' WHERE user_id=? AND grant_id=? AND state<>'revoked'",userId,grantId).run();
    return result.meta.changes>0;
  }
}
