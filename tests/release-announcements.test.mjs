import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {validateAnnouncements,createAnnouncementReceipt,isNewerVersion} from '../app/release-announcements-model.ts';
import {announcementReceiptPrefix} from '../app/release-announcements-model.ts';
import {tsxFunction} from './fixtures/tsx-functions.mjs';
import {loadTsx} from './fixtures/tsx-components.mjs';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';

const announcement={version:'1.24.1',date:'2026-09-10',title:'每次更新都有公告',changes:['首次访问新版时显示公告。']};
test('publishing requires a real announcement for the exact current version',()=>{
  assert.deepEqual(validateAnnouncements([announcement], '1.24.1'),[announcement]);
  assert.throws(()=>validateAnnouncements([announcement], '1.24.2'),/当前版本/);
  assert.throws(()=>validateAnnouncements([{...announcement,changes:[]}], '1.24.1'),/公告/);
  assert.throws(()=>validateAnnouncements([announcement,announcement], '1.24.1'),/重复/);
  assert.throws(()=>validateAnnouncements([{...announcement,date:'2026-02-30'}], '1.24.1'),/日期/);
});
test('unread current release appears even when page and server are already the same version',()=>{
  const values=new Map();const storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};
  const receipt=createAnnouncementReceipt(()=>storage);
  assert.equal(receipt.hasRead('1.24.1'),false);
  receipt.acknowledge('1.24.1');
  assert.equal(createAnnouncementReceipt(()=>storage).hasRead('1.24.1'),true);
  assert.equal(receipt.hasRead('1.24.2'),false);
  receipt.acknowledge('1.24.0'); // A stale tab cannot undo the newer acknowledgement.
  assert.equal(receipt.hasRead('1.24.1'),true);
  assert.deepEqual([...values.values()],['read','read']);
});
test('blocked storage never breaks learning and remembers acknowledgement for this mount',()=>{
  const receipt=createAnnouncementReceipt(()=>{throw new Error('storage unavailable');});
  assert.equal(receipt.hasRead('1.24.1'),false);
  receipt.acknowledge('1.24.1');
  assert.equal(receipt.hasRead('1.24.1'),true);
});
test('version comparison handles 1.9 to 1.10 without announcing rollbacks as upgrades',()=>{
  assert.equal(isNewerVersion('1.10.0','1.9.0'),true);
  assert.equal(isNewerVersion('1.24.0','1.24.1'),false);
  assert.equal(isNewerVersion('1.24.1','1.24.1'),false);
  assert.equal(isNewerVersion('bad','1.24.1'),false);
});
test('checked-in announcements cover the application release and preserve prior entries',async()=>{
  const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
  const data=JSON.parse(await readFile(new URL('../app/release-announcements.json',import.meta.url),'utf8'));
  assert.equal(validateAnnouncements(data,pkg.version)[0].version,pkg.version);
  assert.ok(data.some(entry=>entry.version==='1.24.0'));
});
test('actual announcement keeps manual access and synchronizes acknowledgement without auto-opening',()=>{
  const values=new Map(),listeners=new Map();let visible=false;
  const storage={getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)};
  const window={addEventListener:(name,handler)=>listeners.set(name,handler),removeEventListener:(name,handler)=>{if(listeners.get(name)===handler)listeners.delete(name);}};
  const mount=tsxFunction(new URL('../app/release-announcement.tsx',import.meta.url),'ReleaseAnnouncement',{
    current:announcement,receipt:createAnnouncementReceipt(()=>storage),setVisible:value=>{visible=value;},window,announcementReceiptPrefix,
  },{effect:'const onStorage'});
  const cleanup=mount();assert.equal(visible,false);
  const key=announcementReceiptPrefix+announcement.version;
  values.set(key,'read');listeners.get('storage')({key});assert.equal(visible,false);
  listeners.get('zhixue:show-release-announcement')();assert.equal(visible,true);
  values.delete(key);listeners.get('storage')({key:null});assert.equal(visible,true,'manual open remains readable');
  visible=false;listeners.get('storage')({key:null});assert.equal(visible,false,'clearing storage must not open a dialog');
  cleanup();assert.equal(listeners.size,0);
});
test('actual announcement uses an accessible managed center dialog with all release changes',async()=>{
  const {ReleaseAnnouncement}=loadTsx(new URL('../app/release-announcement.tsx',import.meta.url));
  const html=renderToStaticMarkup(createElement(ReleaseAnnouncement));
  assert.match(html,/<dialog[^>]*class="study-panel release-dialog"/);
  assert.match(html,/data-variant="center"/);
  assert.match(html,/aria-labelledby=/);
  assert.match(html,/关闭知学更新/);
  assert.match(html,/我知道了/);
  const current=JSON.parse(await readFile(new URL('../app/release-announcements.json',import.meta.url),'utf8'))[0];
  assert.ok(html.includes(renderToStaticMarkup(createElement('h2',null,current.title))));
  assert.match(html,/历史公告/);
});
