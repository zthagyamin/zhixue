import {DatabaseSync} from 'node:sqlite';
import {readFile} from 'node:fs/promises';

const plain=row=>Object.fromEntries(Object.entries(row));
class SqliteD1Statement {
  constructor(owner,query,parameters=[]){this.owner=owner;this.query=query;this.parameters=parameters;}
  bind(...parameters){
    if(parameters.length>100) throw new Error('D1 bound parameter limit');
    return new SqliteD1Statement(this.owner,this.query,parameters);
  }
  executeAll(){
    this.owner.queryCount++;
    const rows=this.owner.sqlite.prepare(this.query).all(...this.parameters).map(plain);
    return {success:true,results:rows,meta:{changes:this.owner.sqlite.prepare('SELECT changes() AS n').get().n}};
  }
  async all(){return this.executeAll();}
  async raw(){return this.executeAll().results.map(Object.values);}
  async run(){
    this.owner.queryCount++;const result=this.owner.sqlite.prepare(this.query).run(...this.parameters);
    return {success:true,results:[],meta:{changes:result.changes,last_row_id:Number(result.lastInsertRowid)}};
  }
  async first(column){const row=this.executeAll().results[0];return row===undefined?null:column===undefined?row:row[column];}
}
export class SqliteD1Database {
  constructor(sqlite){this.sqlite=sqlite;this.queryCount=0;}
  prepare(query){if(Buffer.byteLength(query)>100000) throw new Error('D1 query size limit');return new SqliteD1Statement(this,query);}
  async batch(statements){
    this.sqlite.exec('BEGIN IMMEDIATE');
    try {const results=statements.map(statement=>statement.executeAll());this.sqlite.exec('COMMIT');return results;}
    catch(error){this.sqlite.exec('ROLLBACK');throw error;}
  }
}
export async function migrateD1(sqlite,from=0,to=Infinity){
  const journal=JSON.parse(await readFile(new URL('../../drizzle/meta/_journal.json',import.meta.url),'utf8'));
  for(const entry of journal.entries.filter(row=>row.idx>=from&&row.idx<=to)) {
    sqlite.exec(await readFile(new URL(`../../drizzle/${entry.tag}.sql`,import.meta.url),'utf8'));
  }
}
export async function openD1(path=':memory:',migrate=true){
  const sqlite=new DatabaseSync(path);sqlite.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  if(migrate) await migrateD1(sqlite);
  return {sqlite,binding:new SqliteD1Database(sqlite)};
}
