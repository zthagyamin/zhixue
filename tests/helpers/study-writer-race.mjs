import {createHash} from 'node:crypto';
import {AccountStudyAccessStore} from '../../db/account-study-access-store.ts';

export async function activateSyntheticWriter(binding,scope){
 const access=new AccountStudyAccessStore(binding),profile=await access.profile(scope.userId);
 const secret=Buffer.alloc(32,29).toString('base64url'),grantId='qualification-writer';
 await access.register(scope.userId,{grantId,libraryId:scope.libraryId,tokenHash:createHash('sha256').update(secret).digest('hex'),
  label:'Synthetic writer boundary',expectedProfileRevision:profile.revision,replaceLibrary:false});
 await access.activate(secret);
 return{grantId,access};
}

/** Intervene exactly at the target statement, after its earlier validation. */
export function changeWriterAtCommit(binding,sqlite,scope,writer,change,table){
 const prepare=binding.prepare.bind(binding);let reached=false;
 const intervene=async()=>{
  reached=true;
  if(change==='revoke')await writer.access.revoke(scope.userId,writer.grantId);
  if(change==='expire')sqlite.prepare("UPDATE account_study_grants SET expires_at='2000-01-01T00:00:00.000Z' WHERE grant_id=?").run(writer.grantId);
  if(change==='replace-library'){
   const profile=await writer.access.profile(scope.userId),secret=Buffer.alloc(32,31).toString('base64url');
   await writer.access.register(scope.userId,{grantId:'qualification-replacement',libraryId:'library-replacement',tokenHash:createHash('sha256').update(secret).digest('hex'),
    label:'Synthetic replacement',expectedProfileRevision:profile.revision,replaceLibrary:true});
   await writer.access.activate(secret);
  }
 };
 const pattern=new RegExp('^(?:INSERT(?: OR IGNORE)? INTO|UPDATE|DELETE FROM) '+table+'(?:\\b)');
 const batch=binding.batch.bind(binding);
 binding.batch=async statements=>{
  if(!reached&&statements.some(statement=>pattern.test(statement.query)))await intervene();
  return batch(statements);
 };
 const wrap=statement=>new Proxy(statement,{get(target,key){
  if(key==='bind')return(...args)=>wrap(target.bind(...args));
  if((key==='run'||key==='all')&&pattern.test(target.query))return async(...args)=>{if(!reached)await intervene();return target[key](...args);};
  return Reflect.get(target,key);
 }});
 binding.prepare=query=>wrap(prepare(query));
 return()=>reached;
}
