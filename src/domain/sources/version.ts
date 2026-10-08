export type SourceVersion={libraryId:string;snapshotId:string;revision:number;eventThrough:number;taskThrough:number;observedAt:string};
/** Compare only versions of the same verified library; explicit library selection is a host action. */
export function sourceVersionRegresses(incoming:SourceVersion,previous:SourceVersion|null|undefined):boolean{
  return Boolean(previous&&previous.libraryId===incoming.libraryId&&(incoming.revision<previous.revision||incoming.snapshotId===previous.snapshotId&&(
    incoming.eventThrough<previous.eventThrough||incoming.taskThrough<previous.taskThrough||incoming.observedAt<previous.observedAt)));
}
