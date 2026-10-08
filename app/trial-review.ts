/** Ephemeral self-assessment only. Never persisted as a grade or learning event. */
export function markTrialForRetry(marked:readonly string[],id:string,needsRetry:boolean):string[]{
 return needsRetry?Array.from(new Set([...marked,id])):marked.filter(value=>value!==id);
}
export function trialRetryQueue(questions:readonly {id:string}[],marked:readonly string[]):number[]{
 const selected=new Set(marked);
 return questions.flatMap((question,index)=>selected.has(question.id)?[index]:[]);
}
