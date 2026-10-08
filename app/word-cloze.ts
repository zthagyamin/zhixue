/** Derive only from supplied material; never synthesize a source sentence. */
export function makeWordCloze(sentence:string,word:string):string|null{
  if(!sentence||!word.trim())return null;
  const escaped=word.trim().replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const match=new RegExp(`(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])`,'giu');
  const result=sentence.replace(match,'______');return result===sentence?null:result;
}
