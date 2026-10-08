import test from 'node:test';
import assert from 'node:assert/strict';
import {createStudyVisitSession,studyVisitPrefix} from '../app/study-visit-state.ts';
import {createAnnouncementReceipt,announcementReceiptPrefix} from '../app/release-announcements-model.ts';
function fixture(){const values=new Map();return {values,storage:{getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)}};}
const enter=(storage,scope='account:a')=>createStudyVisitSession(()=>storage,scope);
test('first study arrival creates an exposure baseline, not a fabricated read receipt',()=>{
 const {storage,values}=fixture();const visit=enter(storage).enter('1.37.0');
 assert.deepEqual(visit,{version:'1.37.0',firstVisit:true,showWelcome:true,announcementVersion:null});
 assert.equal(createAnnouncementReceipt(()=>storage).hasRead('1.37.0'),false);
 assert.equal([...values.keys()].some(key=>key.startsWith(announcementReceiptPrefix)),false);
});
test('effect replay and a new page both keep the first version silent',()=>{
 const {storage}=fixture(),session=enter(storage),first=session.enter('1.37.0');
 assert.equal(session.enter('1.37.0'),first);
 assert.equal(enter(storage).enter('1.37.0').announcementVersion,null);
 assert.equal(enter(storage).enter('1.37.0').firstVisit,false);
});
test('a real upgrade remains eligible after a reload until a separate read receipt is acknowledged',()=>{
 const {storage}=fixture();enter(storage).enter('1.36.0');
 const update=enter(storage).enter('1.37.0');assert.equal(update.announcementVersion,'1.37.0');
 assert.equal(update.showWelcome,false);assert.equal(enter(storage).enter('1.37.0').announcementVersion,'1.37.0');
 const receipt=createAnnouncementReceipt(()=>storage);receipt.acknowledge('1.37.0');
 assert.equal(receipt.hasRead(update.announcementVersion),true);
 assert.equal(enter(storage).enter('1.38.0').announcementVersion,'1.38.0');
});
test('downgrades and old tabs cannot move the version baseline backwards',()=>{
 const {storage,values}=fixture();const old=enter(storage);old.enter('1.9.0');
 enter(storage).enter('1.10.0');old.dismissWelcome();
 const stored=JSON.parse(values.get(studyVisitPrefix+encodeURIComponent('account:a')));
 assert.equal(stored.latestVersion,'1.10.0');assert.equal(stored.welcomeDismissed,true);
 assert.equal(enter(storage).enter('1.9.0').announcementVersion,null);
 assert.equal(enter(storage).enter('1.10.0').announcementVersion,'1.10.0');
});
test('accounts do not borrow one another\'s first visit or welcome dismissal',()=>{
 const {storage}=fixture();const a=enter(storage);a.enter('1.36.0');a.dismissWelcome();
 assert.equal(enter(storage).enter('1.37.0').showWelcome,false);
 assert.deepEqual(enter(storage,'account:b').enter('1.37.0'),{version:'1.37.0',firstVisit:true,showWelcome:true,announcementVersion:null});
});
test('previously completed or skipped teaching does not create another welcome task',()=>{
 const {storage}=fixture();const visit=enter(storage).enter('1.37.0',true);
 assert.equal(visit.showWelcome,false);assert.equal(visit.announcementVersion,null);
});
for(const bad of ['{broken','{}','null','{"firstVersion":"1.99.0","latestVersion":"1.0.0","upgradeVersion":null,"welcomeDismissed":false}'])test(`unknown or invalid history is non-interrupting: ${bad}`,()=>{
 const {storage,values}=fixture();values.set(studyVisitPrefix+encodeURIComponent('account:a'),bad);
 assert.equal(enter(storage).enter('1.37.0').announcementVersion,null);
});
test('blocked storage is safe and dismissal works for the current session',()=>{
 const session=createStudyVisitSession(()=>{throw new Error('blocked');},'account:a');
 assert.equal(session.enter('1.37.0').announcementVersion,null);session.dismissWelcome();
 assert.equal(session.enter('1.37.0').showWelcome,false);
});
test('write-only storage failure does not mark the release as read',()=>{
 const storage={getItem:()=>null,setItem(){throw new Error('quota');}};
 const visit=enter(storage).enter('1.37.0');assert.equal(visit.announcementVersion,null);
 assert.equal(createAnnouncementReceipt(()=>storage).hasRead('1.37.0'),false);
});
test('invalid app versions cannot poison a valid visit record',()=>{
 const {storage,values}=fixture();const session=enter(storage);session.enter('1.37.0');const before=[...values];
 assert.throws(()=>session.enter('invalid'),/version/);assert.deepEqual([...values],before);
});
