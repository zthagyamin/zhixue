import type {FlashcardSupport} from './flashcard-support';
import type {PaperFigureAsset} from './paper-library-client';
export type OcclusionSupport=Extract<FlashcardSupport,{mode:'occlusion'}>;
export async function verifyFlashcardImage(asset:PaperFigureAsset,support:OcclusionSupport){
 if(asset.assetId!==support.assetId||asset.sourceVersion!==support.sourceVersion||asset.assetVersion!==support.assetVersion||!['image/png','image/jpeg'].includes(asset.mime)||typeof asset.data!=='string'||asset.data.length>6666668)throw Error('图片与题目版本不一致，请重新同步来源。');
 const bytes=Uint8Array.from(atob(asset.data),c=>c.charCodeAt(0));
 if(bytes.length>5000000)throw Error('图片过大。');
 const hash=await crypto.subtle.digest('SHA-256',bytes);
 if(Array.from(new Uint8Array(hash),v=>v.toString(16).padStart(2,'0')).join('')!==support.assetVersion)throw Error('图片版本已变化，请重新同步来源。');
 return new Blob([bytes],{type:asset.mime});
}
/** Paint source and opaque masks in a single synchronous frame. No answer text is drawn. */
export function drawFlashcardMasks(canvas:HTMLCanvasElement,source:CanvasImageSource,width:number,height:number,support:OcclusionSupport,revealed:boolean){
 if(width<=0||height<=0||width>8192||height>8192||width*height>12000000)throw Error('图片像素过大，请缩小来源图片。');
 const scale=Math.min(1,1600/Math.max(width,height));canvas.width=Math.max(1,Math.round(width*scale));canvas.height=Math.max(1,Math.round(height*scale));
 const ctx=canvas.getContext('2d');if(!ctx)throw Error('当前浏览器无法显示遮挡卡。');
 ctx.drawImage(source,0,0,canvas.width,canvas.height);
 for(const mask of support.masks){if(revealed&&mask.id===support.activeMaskId)continue;
  const x=Math.floor(Number(mask.x)/100*canvas.width),y=Math.floor(Number(mask.y)/100*canvas.height),right=Math.ceil((Number(mask.x)+Number(mask.width))/100*canvas.width),bottom=Math.ceil((Number(mask.y)+Number(mask.height))/100*canvas.height);
  ctx.fillStyle=mask.id===support.activeMaskId?'#173f35':'#25302d';ctx.fillRect(x,y,right-x,bottom-y);
  if(mask.id===support.activeMaskId){ctx.fillStyle='#ffffff';ctx.font='bold 18px sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText('?',(x+right)/2,(y+bottom)/2,Math.max(1,right-x));}
 }
}
