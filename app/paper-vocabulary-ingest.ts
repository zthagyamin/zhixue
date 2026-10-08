// @ts-expect-error TS5097: standalone Node regression tests.
import {PaperVocabularyError,type PaperVocabularyClient} from './paper-vocabulary-client.ts';
// @ts-expect-error TS5097: standalone Node regression tests.
import {verifiedPaperScope,type PaperLibraryClient} from './paper-library-client.ts';
// @ts-expect-error TS5097: standalone Node regression tests.
import {normalizePaperTerm,rememberIngestedVocabulary,safePaperSource,selectPaperRange,validVocabularyReceipt,type PaperWord,type VocabularyRequest,type VocabularyReceipt} from './paper-study.ts';
import type {PaperDraftSession} from './paper-draft-store';

export type PaperVocabularyIngestOptions={
  owner:string;expected:{localLibraryId?:string;accountLibraryId?:string};
  client?:PaperVocabularyClient;libraryClient?:PaperLibraryClient;
  entryIds?:readonly string[];retry?:boolean;isCurrent?:()=>boolean;
};
export type PaperVocabularyIngestResult={request:VocabularyRequest;receipt:VocabularyReceipt};
export type PaperVocabularyReadback={status:'visible'|'deferred'|'pending'|'unavailable';matched:number;total:number;itemKeys:string[];mode:'local'|'account'};
export const PAPER_VOCABULARY_TARGET='01 学习/学术英语词库/00 学术阅读词卡库.md';

function checkOccurrence(session:PaperDraftSession,entry:PaperWord){
  const original=Number.isInteger(entry.start)&&Number.isInteger(entry.end)
    ?selectPaperRange(session.paper,entry.paragraphId,entry.start,entry.end):null;
  if(!original||original.id!==entry.id||original.start!==entry.start||original.end!==entry.end||original.term!==entry.term||original.context!==entry.context||entry.paperTitle!==session.paper.title||entry.section!==original.section)
    throw new Error('选词与当前论文原句不一致，请重新选择。');
  if(typeof entry.meaning!=='string'||!entry.meaning.trim()||entry.meaning.length>1000)throw new Error('请先补充有效的语境释义（最多 1000 字）。');
  if(!Number.isInteger(entry.page)||entry.page<0||entry.page>5000||(entry.page===0&&!entry.locator?.trim()))throw new Error('请核对来源页码或微段定位。');
}

/** Both UI entry points use one immutable request, including after a remount.
 * This service writes vocabulary only; it never manufactures a learning event. */
export function ingestPaperVocabulary(session:PaperDraftSession,options:PaperVocabularyIngestOptions):Promise<PaperVocabularyIngestResult>{
  if(session.owner!==options.owner)return Promise.reject(new Error('当前论文或资料库已变化，请回到原页面核对。'));
  return session.exclusive('vocabulary-ingest',async()=>{
    const current=()=>{if(session.owner!==options.owner||options.isCurrent?.()===false)throw new Error('当前论文或资料库已变化，请回到原页面核对。');};
    let attemptedId:string|undefined;
    try{
      current();
      const client=options.client;if(!client)throw new Error('Companion 未连接。所选词已保留，可连接后重试或导出表格。');
      if(!options.expected.localLibraryId&&!options.expected.accountLibraryId)throw new Error('资料库尚未核对，请先检测 Companion 连接。');
      await session.flush();current();
      const snapshot=structuredClone(session.snapshot().draft);let pending=snapshot.pending;
      if(pending&&!options.retry)throw new Error('上次收词仍待确认，请先重试原请求；新选择继续保留。');
      if(options.retry&&!pending)throw new Error('没有待确认请求，请重新选择要收录的词。');
      if(!pending){
        const requested=options.entryIds?new Set(options.entryIds):null;
        let entries=snapshot.selected.filter(entry=>!requested||requested.has(entry.id));
        if(!entries.length||entries.length>32||requested&&(requested.size!==options.entryIds!.length||entries.length!==requested.size))throw new Error('所选词已变化，请重新选择要收录的词。');
        entries.forEach(entry=>checkOccurrence(session,entry));
        if(options.libraryClient&&(session.paper.origin||entries.some(entry=>!safePaperSource(entry.sourceNote)))){
          const catalog=await options.libraryClient.catalog();current();
          const scope=verifiedPaperScope(catalog,options.expected);
          const material=await options.libraryClient.material({...scope,paper:session.paper});current();
          if(material.localLibraryId!==scope.localLibraryId||!safePaperSource(material.sourceNote))throw new Error('来源文字快照尚未确认，所选词继续保留。');
          const sourceNote=material.sourceNote;
          entries=entries.map(entry=>({...entry,sourceNote}));
          await session.update(d=>{
            if(d.sourceNoteOverride!==snapshot.sourceNoteOverride)return d;
            const previous=snapshot.sourceNoteOverride??session.paper.sourceNote??'';
            return{...d,sourceNoteOverride:sourceNote,selected:d.selected.map(entry=>entry.sourceNote===previous||snapshot.selected.some(original=>original.id===entry.id&&original.sourceNote===entry.sourceNote)?{...entry,sourceNote}:entry)};
          });
          await session.flush();current();
        }
        if(entries.some(entry=>!safePaperSource(entry.sourceNote)))throw new Error('请先核对来源笔记，再收录词汇。');
        if(new Set(entries.map(entry=>entry.sourceNote)).size!==1)throw new Error('同一批收词需要使用同一篇来源笔记。');
        const target=await client.target(entries[0].sourceNote);current();
        if(!target||typeof target.localLibraryId!=='string'||!target.localLibraryId||target.target!==PAPER_VOCABULARY_TARGET||typeof target.revision!=='string'||!/^[a-f0-9]{64}$/.test(target.revision))throw new Error('词库信息尚未完整核对，请重试。');
        if(options.expected.accountLibraryId?target.accountLibraryId!==options.expected.accountLibraryId:target.localLibraryId!==options.expected.localLibraryId)throw new Error('当前资料库与 Companion 不一致，请切回对应资料库。');
        pending={requestId:crypto.randomUUID(),localLibraryId:target.localLibraryId,...(options.expected.accountLibraryId?{accountLibraryId:options.expected.accountLibraryId}:{}),expectedRevision:target.revision,entries};
        const captured=structuredClone(pending);
        await session.update(d=>{if(d.pending)throw new Error('有另一份收词请求待确认，请先核对。');return{...d,pending:captured};});
        await session.flush();
      }
      current();
      if(options.expected.accountLibraryId?pending.accountLibraryId!==options.expected.accountLibraryId:pending.localLibraryId!==options.expected.localLibraryId)throw new Error('原请求属于另一资料库，请切回对应资料库。');
      pending.entries.forEach(entry=>checkOccurrence(session,entry));
      const sent=structuredClone(pending);attemptedId=sent.requestId;
      const receipt=await client.append(structuredClone(sent));
      if(!validVocabularyReceipt(receipt,sent)||typeof receipt.gatewayRecognized!=='boolean')throw new Error('入库回执不完整，已保留原请求，请重试核对。');
      await session.update(d=>d.pending?.requestId===sent.requestId?{
        ...d,pending:undefined,receipt,ingestedVocabulary:rememberIngestedVocabulary(d,sent,receipt),
        selected:d.selected.filter(entry=>{const original=sent.entries.find(value=>value.id===entry.id),result=receipt.results.find(value=>value.id===entry.id);return !original||result?.status==='conflict'||JSON.stringify(entry)!==JSON.stringify(original);}),
      }:d);
      await session.flush();return structuredClone({request:sent,receipt});
    }catch(error){
      if(error instanceof PaperVocabularyError&&error.confirmedUnwritten&&attemptedId){
        await session.update(d=>d.pending?.requestId===attemptedId?{...d,pending:undefined}:d);await session.flush();
      }
      throw error;
    }
  });
}
export function paperVocabularyReceiptMessage(receipt:VocabularyReceipt){
  const added=receipt.results.filter(result=>result.status==='added').length,existing=receipt.results.filter(result=>result.status==='existing').length,conflicts=receipt.results.filter(result=>result.status==='conflict').length;
  if(!added&&!existing)return `${conflicts} 个词义有冲突，已保留在托盘中待核对。`;
  return `${added?`已写入 ${added} 个词`:''}${added&&existing?'；':''}${existing?`${existing} 个词已存在`:''}${conflicts?`；${conflicts} 个词义待核对`:''}。`;
}
/** Consume canonical items; a refresh itself is never evidence of membership. */
export function matchPaperVocabulary(entries:readonly PaperWord[],items:readonly {itemKey:string;word:string;meaning:string}[],allowedItemKeys?:readonly string[]){
  const allowed=allowedItemKeys?new Set(allowedItemKeys):null;
  const matches=entries.map(entry=>items.find(item=>item.itemKey&&(!allowed||allowed.has(item.itemKey))&&normalizePaperTerm(item.word)===normalizePaperTerm(entry.term)&&normalizePaperTerm(item.meaning)===normalizePaperTerm(entry.meaning)));
  return{matched:matches.filter(Boolean).length,total:entries.length,itemKeys:[...new Set(matches.flatMap(item=>item?[item.itemKey]:[]))]};
}
