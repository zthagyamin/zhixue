import {env} from 'cloudflare:workers';
import {createDatabaseAccess} from '../src/infrastructure/database';
const database=createDatabaseAccess(()=>env as Cloudflare.Env&{DB?:D1Database});
export const getDatabaseBinding=database.getDatabaseBinding,getDb=database.getDb;
