import {drizzle} from 'drizzle-orm/d1';
// @ts-expect-error TS5097: standalone Node contracts.
import * as schema from './schema.ts';
export function createDatabaseAccess(environment:()=>{DB?:D1Database}){
  function getDatabaseBinding():D1Database{
    const databaseBinding=environment().DB;
    if(!databaseBinding)throw new Error('Cloudflare D1 binding `DB` is unavailable. Set the `d1` field in .openai/hosting.json to `DB` or let your control plane inject the real binding values before using the database.');
    return databaseBinding;
  }
  return{getDatabaseBinding,getDb:()=>drizzle(getDatabaseBinding(),{schema})};
}
export type StudyDatabase=ReturnType<ReturnType<typeof createDatabaseAccess>['getDb']>;
