// @ts-expect-error TS5097: standalone Node regression tests.
import {PaperLibraryError,verifiedPaperScope,type PaperLibraryCatalog,type PaperLibraryClient,type PaperDestination} from './paper-library-client.ts';
// @ts-expect-error TS5097: standalone Node regression tests.
import {readingNoteMarkdown} from './paper-reading-note.ts';
import type {PaperDraftSession} from './paper-draft-store';
import type {PaperStudyData} from './paper-study';
export function savePaperNote(session:PaperDraftSession,paper:PaperStudyData,options:{client?:PaperLibraryClient;expected:{localLibraryId?:string;accountLibraryId?:string};catalog?:PaperLibraryCatalog|null;selection:string;directory:string}){
 return session.exclusive('note-save',async()=>{
  let attemptedId:string|undefined;
  try{
   if(!options.client)throw new Error('请先连接 Companion；草稿已保留，可以导出。');
   await session.flush();const snapshot=structuredClone(session.snapshot().draft);let pending=snapshot.pendingNote;
   if(!pending){
    const catalog=options.catalog??await options.client.catalog(),scope=verifiedPaperScope(catalog,options.expected);
    const destination:PaperDestination|undefined=options.selection==='obsidian'?{kind:'obsidian',directory:options.directory}:catalog.destinations.find(d=>d.kind==='notion'&&d.sourceId===options.selection);
    if(!destination)throw new Error('请选择已授权的保存位置。');
    const markdown=readingNoteMarkdown(paper,snapshot);if(markdown.length>100000)throw new Error('笔记过长，请按章节保存。');
    pending={requestId:crypto.randomUUID(),...scope,destination,title:paper.title,markdown,...(paper.origin?{source:paper.origin}:{})};const captured=pending;
    await session.update(d=>({...d,pendingNote:captured}));await session.flush();
   }
   attemptedId=pending.requestId;const receipt=await options.client.save(pending);
   const locationValid=receipt.kind==='obsidian'?typeof receipt.path==='string'&&receipt.path.endsWith('.md')&&!receipt.path.startsWith('/')&&!receipt.path.split('/').includes('..'):typeof receipt.url==='string'&&/^https:\/\/www\.notion\.so\/[a-f0-9]{32}$/.test(receipt.url);
   if(receipt.requestId!==pending.requestId||receipt.localLibraryId!==pending.localLibraryId||receipt.status!=='written'||receipt.kind!==pending.destination.kind||!locationValid)throw new Error('保存回执不完整，请保留原请求重试。');
   await session.update(d=>d.pendingNote?.requestId===attemptedId?{...d,pendingNote:undefined,noteReceipt:receipt}:d);await session.flush();return receipt;
  }catch(error){if(error instanceof PaperLibraryError&&error.noWrite&&attemptedId){await session.update(d=>d.pendingNote?.requestId===attemptedId?{...d,pendingNote:undefined}:d);await session.flush();}throw error;}
 });
}
