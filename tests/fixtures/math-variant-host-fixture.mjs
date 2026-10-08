import {sealStudyItem,sealStudySnapshot} from '../../app/account-study-content.ts';
import {reviewedSource,reviewedCases} from './math-mapping-fixtures.mjs';
import {snapshotBody} from './account-study-fixtures.mjs';
import {rebuildApprovedMathVariant} from '../../src/infrastructure/math-study/mapping-client.ts';
export async function variantSource({legacy=false}={}){
 const source=reviewedSource(reviewedCases[2]);delete source.item.contentHash;
 if(legacy){source.item.schemaVersion=1;delete source.item.learningSupport;}
 const item=await sealStudyItem(source.item),snapshot=await sealStudySnapshot(snapshotBody([item],{libraryId:'library',snapshotId:'synthetic-snapshot'}));
 const record={schemaVersion:1,preparation:{...source.preparation,mapping:{...source.preparation.mapping,parentContentHash:item.contentHash}},provenance:{originGrantId:'publisher',publishedAt:'2026-10-08T01:00:00.000Z'},technicalValidation:{schemaVersion:1,templateVersion:1}};
 return {item,snapshot,record};
}
export function mappingFetcher(source,{absent=false,offline=false}={}){
 return async(_,init)=>{
  if(offline)throw Error('network unavailable');
  const request=JSON.parse(init.body);if(absent)return Response.json({status:'unavailable'});
  if(request.action==='math-mapping-read')return Response.json({status:'available',...source.record});
  if(request.action==='math-variant')return Response.json({status:'available',...await rebuildApprovedMathVariant(source,source.record,request.seed),mapping:source.record.preparation.mapping});
  throw Error('unexpected synthetic action');
 };
}
