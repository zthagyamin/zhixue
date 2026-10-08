export type FigureRegion={x:number;y:number;width:number;height:number};
export type PaperFigure={assetId:string;label:string;title:string;caption:string;sourceVersion:string;assetVersion:string;kind:'pdf'|'image';page?:number;region?:FigureRegion};
const object=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:{};
export function parsePaperFigures(value:unknown):PaperFigure[]{
 if(!Array.isArray(value)||value.length>64)throw new Error('图表清单无效。');
 const ids=new Set<string>(),labels=new Set<string>();
 return value.map(raw=>{
  const v=object(raw),allowed=['assetId','label','title','caption','sourceVersion','assetVersion','kind','page','region'];
  if(Object.keys(v).some(key=>!allowed.includes(key)))throw new Error('图表只能引用已登记资产。');
  const str=(key:string,max:number)=>{const s=v[key];if(typeof s!=='string'||!s.trim()||s.length>max||Array.from(s).some(c=>c.charCodeAt(0)<32&&!['\n','\r','\t'].includes(c)))throw new Error('图表字段无效。');return s;};
  const assetId=str('assetId',80),label=str('label',80),title=str('title',400),caption=str('caption',4000),sourceVersion=str('sourceVersion',64),assetVersion=str('assetVersion',64);
  if(!/^[A-Za-z0-9_-]+$/.test(assetId)||ids.has(assetId)||labels.has(label.toLowerCase())||![sourceVersion,assetVersion].every(s=>/^[a-f0-9]{64}$/.test(s))||!['pdf','image'].includes(String(v.kind)))throw new Error('图表身份无效。');
  ids.add(assetId);labels.add(label.toLowerCase());
  if(v.kind==='pdf'&&(!Number.isInteger(v.page)||Number(v.page)<1||Number(v.page)>200)||v.kind==='image'&&v.page!==undefined)throw new Error('图表页码无效。');
  let region:FigureRegion|undefined;
  if(v.region!==undefined){const r=object(v.region);if(Object.keys(r).length!==4||!['x','y','width','height'].every(k=>typeof r[k]==='number'&&Number.isFinite(r[k]))||Number(r.x)<0||Number(r.y)<0||Number(r.width)<=0||Number(r.height)<=0||Number(r.x)+Number(r.width)>1||Number(r.y)+Number(r.height)>1)throw new Error('图表区域无效。');region={x:Number(r.x),y:Number(r.y),width:Number(r.width),height:Number(r.height)};}
  return{assetId,label,title,caption,sourceVersion,assetVersion,kind:v.kind as 'pdf'|'image',...(v.kind==='pdf'?{page:Number(v.page)}:{}),...(region?{region}:{})};
 });
}
export function figureReferences(text:string,figures:PaperFigure[]=[]){
 const code=[...text.matchAll(/`+[^`]*`+/g)].map(m=>({start:m.index,end:m.index+m[0].length}));
 const result:{start:number;end:number;assetId:string}[]=[];
 for(const m of text.matchAll(/\b(?:Fig\.?|Figure|Table)\s+\d+(?:\([a-z]\))?/gi)){
  const start=m.index,end=start+m[0].length;
  if(/[\w]/.test(text[end]??'')||code.some(c=>start>=c.start&&start<c.end))continue;
  const canonical=(s:string)=>s.toLowerCase().replace(/^fig\.?\s+/,'figure ').replace(/\s+/g,' ');
  const figure=figures.find(f=>canonical(f.label)===canonical(m[0]));
  if(figure)result.push({start,end,assetId:figure.assetId});
 }
 return result;
}
export function figureCrop(width:number,height:number,region:FigureRegion={x:0,y:0,width:1,height:1}){return{x:Math.floor(width*region.x),y:Math.floor(height*region.y),width:Math.max(1,Math.floor(width*region.width)),height:Math.max(1,Math.floor(height*region.height))};}
