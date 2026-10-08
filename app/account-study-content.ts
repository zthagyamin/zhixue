import type {StudyWordBody,StudyItemBody,StudyItemVersion,StudySnapshotBody,StudySnapshot,StudyBundle} from '../src/domain/sync';
export type {StudyWordBody,StudyPracticeBody,StudyItemBody,StudyItemVersion,StudySnapshotBody,StudySnapshot,StudyBundle} from '../src/domain/sync';
// @ts-expect-error TS5097: standalone Node source contracts.
import {studyObject,studyText,studyId,studyDigest,studyCount,studyIso,studySize,studyHash} from '../src/domain/sync/index.ts';
// @ts-expect-error TS5097: standalone Node source contracts.
export {studyObject,studyText,studyId,studyDigest,studyCount,studyIso,studySize,studyHash} from '../src/domain/sync/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {parseLearningSupport} from './learning-support.ts';
import type {PluginType,RoutableStudyItem} from './plugin-routing';
// @ts-expect-error TS5097: Node contract tests execute explicit TypeScript extensions.
import {compatiblePluginTypes,resolvePluginType} from './plugin-routing.ts';

/** Reuse the desktop's compatibility/fallback rules without leaking local refs. */
export function routableStudyItem(item:StudyItemBody):RoutableStudyItem {
  if(item.kind==='word') return {...item.word,pluginType:item.recommendedPlugin,...(item.learningSupport?{learningSupport:item.learningSupport}:{})};
  const p=item.practice;
  const answer=p.questionType==='quiz'&&typeof p.answer==='number'?p.options?.[p.answer]:typeof p.answer==='string'?p.answer:undefined;
  return {...(item.learningSupport?{learningSupport:item.learningSupport}:{}),id:p.itemId,pluginType:p.questionType,prompt:p.prompt,options:p.options,answer,explanation:p.explanation,
    reviewPoint:p.reviewPoint,initialCode:p.initialCode,testCode:p.testCode,solutionCode:p.solutionCode,
    ...(p.questionType==='flashcard'?{front:p.prompt,back:answer||p.explanation||p.reviewPoint}:{}),};
}
export function studyCompatibleModes(item:StudyItemBody):PluginType[] {return compatiblePluginTypes(routableStudyItem(item));}
export function defaultStudyPracticeMode(item:StudyItemBody):PluginType {
  return resolvePluginType(routableStudyItem(item),item.kind==='word'?item.recommendedPlugin:item.practice.questionType);
}

const ITEM_BYTES=64*1024;
const SNAPSHOT_BYTES=2*1024*1024;
const BUNDLE_BYTES=8*1024*1024;
const MAX_ITEMS=10000;
function textList(value:unknown,label:string,max:number,min=0):asserts value is string[] {
  if (!Array.isArray(value)||value.length<min||value.length>max) throw new Error(`invalid-${label}`);
  value.forEach(child=>studyText(child,label));
}
function parseItemBody(raw:unknown,hasHash:boolean):StudyItemBody {
  const common=['schemaVersion','kind','itemKey','eventKind','subjectId','title','sourceHash','completionRule'];
  const object=studyObject(raw,common,['word','language','recommendedPlugin','practice','learningSupport',...(hasHash?['contentHash']:[])]);
  if (object.schemaVersion!==1&&object.schemaVersion!==2||object.schemaVersion===2&&!Object.hasOwn(object,'learningSupport')) throw new Error('unsupported-study-version');
  if(object.schemaVersion===1&&Object.hasOwn(object,'learningSupport'))throw new Error('unknown-study-field');
  for (const key of ['itemKey','subjectId']) studyId(object[key],key);
  studyText(object.title,'title');studyDigest(object.sourceHash);
  if (typeof object.eventKind!=='string'||!['word','python','due'].includes(object.eventKind)) throw new Error('invalid-event-kind');
  if (hasHash) studyDigest(object.contentHash);
  if (object.kind==='word') {
    if (Object.hasOwn(object,'practice')) throw new Error('unknown-study-field');
    if (object.eventKind!=='word'||(object.completionRule!=='three-stage'&&object.completionRule!=='graded-practice')) throw new Error('invalid-word-rule');
    if(typeof object.recommendedPlugin!=='string'||!['three-stage','recall','flashcard','spelling'].includes(object.recommendedPlugin)) throw new Error('invalid-word-plugin');
    studyText(object.language,'language',64);
    if (!/^[a-zA-Z]{2,8}(?:-[a-zA-Z0-9]{1,8})*$/.test(object.language)) throw new Error('invalid-language');
    const word=studyObject(object.word,['word','phonetic','meaning','context','example','source','level','distractors']);
    for (const key of ['word','meaning']) studyText(word[key],key);
    for (const key of ['phonetic','context','example','source','level']) studyText(word[key],key,4000,true);
    textList(word.distractors,'distractors',32);
    const defaultMode=defaultStudyPracticeMode(object as unknown as StudyWordBody);
    if(object.completionRule!==(defaultMode==='three-stage'?'three-stage':'graded-practice')) throw new Error('invalid-word-rule');
  } else if (object.kind==='practice') {
    if (Object.hasOwn(object,'word')||Object.hasOwn(object,'language')||Object.hasOwn(object,'recommendedPlugin')) throw new Error('unknown-study-field');
    if (object.completionRule!=='graded-practice') throw new Error('invalid-practice-rule');
    const p=studyObject(object.practice,['itemId','abilityId','domain','questionType','prompt','sourceLabel'],
      ['options','answer','explanation','reviewPoint','initialCode','testCode','solutionCode']);
    for (const key of ['itemId','abilityId','domain']) studyId(p[key],key);
    studyText(p.prompt,'prompt',32000);studyText(p.sourceLabel,'source-label');
    if (typeof p.questionType!=='string'||!['quiz','recall','calculation','code','flashcard'].includes(p.questionType)) throw new Error('invalid-question-type');
    for (const key of ['explanation','reviewPoint','initialCode','testCode','solutionCode']) {
      if (Object.hasOwn(p,key)) studyText(p[key],key,32000,true);
    }
    if (Object.hasOwn(p,'options')) textList(p.options,'options',32,2);
    if (p.questionType==='quiz') {
      if(object.schemaVersion===2&&(object.learningSupport as {type?:string})?.type==='quiz'){
        if(Object.hasOwn(p,'options')||Object.hasOwn(p,'answer'))throw Error('duplicate-quiz-answer-source');
      }else{
        textList(p.options,'options',32,2);
        studyCount(p.answer,'answer');
        if (p.answer>=p.options.length) throw new Error('invalid-answer');
      }
    } else {
      if (Object.hasOwn(p,'options')) throw new Error('invalid-practice-options');
      if (Object.hasOwn(p,'answer')) studyText(p.answer,'answer',32000,true);
    }
    const structuredCode=object.schemaVersion===2&&(object.learningSupport as {type?:unknown})?.type==='code';
    if (p.questionType==='code' && (typeof p.initialCode!=='string'||!p.initialCode.trim()
      ||!structuredCode&&(typeof p.testCode!=='string'||!p.testCode.trim()))) throw new Error('incomplete-code-item');
    const courseRecall=p.questionType==='recall'&&(object.learningSupport as {schemaVersion?:unknown;type?:unknown})?.schemaVersion===2&&(object.learningSupport as {type?:unknown})?.type==='recall';
    if(courseRecall&&['answer','explanation','reviewPoint'].some(key=>Object.hasOwn(p,key)))throw Error('duplicate-course-reference');
    if (!courseRecall&&['recall','calculation','flashcard'].includes(p.questionType)
      && !['answer','explanation','reviewPoint'].some(key=>typeof p[key]==='string'&&(p[key] as string).trim())) {
      throw new Error('missing-reference-material');
    }
  } else throw new Error('invalid-study-item-kind');
  if(object.schemaVersion===2){const support=parseLearningSupport(object.learningSupport,object.kind==='word'?String(object.recommendedPlugin):String((object.practice as Record<string,unknown>).questionType));if(object.kind==='word'&&support.schemaVersion===2)throw Error('course-task-word');if(support.type==='flashcard'&&(object.kind!=='practice'||!support.parentId))throw Error('flashcard-expansion-required');if(support.type==='spelling'&&(object.kind!=='word'||support.word!==(object.word as Record<string,unknown>).word))throw Error('spelling-mapping-mismatch');}
  studySize(object,ITEM_BYTES);
  const copy=structuredClone(object);delete copy.contentHash;
  return copy as StudyItemBody;
}
export async function sealStudyItem(raw:unknown):Promise<StudyItemVersion> {
  const body=parseItemBody(raw,false);
  const item={...body,contentHash:await studyHash(body)};
  studySize(item,ITEM_BYTES);return item;
}
export async function parseStudyItem(raw:unknown):Promise<StudyItemVersion> {
  const body=parseItemBody(raw,true);
  const contentHash=(raw as StudyItemVersion).contentHash;
  if (await studyHash(body)!==contentHash) throw new Error('study-item-integrity');
  return {...body,contentHash};
}
function parseSnapshotBody(raw:unknown,hasHash:boolean):StudySnapshotBody {
  const object=studyObject(raw,['schemaVersion','libraryId','snapshotId','revision','generatedAt','sourceHash','eventCursor','taskCursor','items'],
    hasHash?['snapshotHash']:[]);
  if (object.schemaVersion!==1) throw new Error('unsupported-study-version');
  studyId(object.libraryId,'library');studyId(object.snapshotId,'snapshot');
  studyCount(object.revision,'revision',1);studyCount(object.eventCursor,'event-cursor');studyCount(object.taskCursor,'task-cursor');
  studyIso(object.generatedAt);studyDigest(object.sourceHash);
  if (hasHash) studyDigest(object.snapshotHash);
  if (!Array.isArray(object.items)||object.items.length>MAX_ITEMS) throw new Error('invalid-snapshot-items');
  const keys=new Set<string>();
  for (const member of object.items) {
    const item=studyObject(member,['itemKey','contentHash']);studyId(item.itemKey,'item-key');studyDigest(item.contentHash);
    if (keys.has(item.itemKey)) throw new Error('duplicate-snapshot-item');
    keys.add(item.itemKey);
  }
  studySize(object,SNAPSHOT_BYTES);
  const copy=structuredClone(object);delete copy.snapshotHash;
  return copy as StudySnapshotBody;
}
export async function sealStudySnapshot(raw:unknown):Promise<StudySnapshot> {
  const body=parseSnapshotBody(raw,false);
  const snapshot={...body,snapshotHash:await studyHash(body)};
  studySize(snapshot,SNAPSHOT_BYTES);return snapshot;
}
export async function parseStudySnapshot(raw:unknown):Promise<StudySnapshot> {
  const body=parseSnapshotBody(raw,true),snapshotHash=(raw as StudySnapshot).snapshotHash;
  if (await studyHash(body)!==snapshotHash) throw new Error('study-snapshot-integrity');
  return {...body,snapshotHash};
}
export async function validateStudyBundle(raw:unknown):Promise<StudyBundle> {
  const object=studyObject(raw,['snapshot','items']);studySize(object,BUNDLE_BYTES);
  const snapshot=await parseStudySnapshot(object.snapshot);
  if (!Array.isArray(object.items)||object.items.length!==snapshot.items.length) throw new Error('incomplete-study-bundle');
  const items:StudyItemVersion[]=[],seen=new Set<string>(),members=new Map(snapshot.items.map(item=>[item.itemKey,item.contentHash]));
  for (const rawItem of object.items) {
    const item=await parseStudyItem(rawItem);
    if (seen.has(item.itemKey)) throw new Error('duplicate-bundle-item');
    if (members.get(item.itemKey)!==item.contentHash) throw new Error('study-bundle-membership');
    seen.add(item.itemKey);items.push(item);
  }
  const byKey=new Map(items.map(item=>[item.itemKey,item]));
  return {snapshot,items:snapshot.items.map(member=>byKey.get(member.itemKey)!)};
}
