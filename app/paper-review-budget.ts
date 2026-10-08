// @ts-expect-error TS5097: direct Node regression execution.
import {studyText} from './account-study-content.ts';
import type {PaperStudyData,PaperParagraph,PaperDraft} from './paper-study';
// @ts-expect-error TS5097: direct Node regression execution.
import {paperReviewerPrompt} from './paper-study.ts';
// @ts-expect-error TS5097: direct Node regression execution.
import {currentPaperSlots,paperTemplate} from './paper-slot-templates.ts';
function excerpt(value:string,limit:number){if(value.length<=limit)return value;let result=value.slice(0,Math.max(0,limit-8));if(/[\uD800-\uDBFF]$/.test(result))result=result.slice(0,-1);return result+'…（节选）';}
/** Bound both message and duplicated context. The caller confirms partial review before sending. */
export function buildPaperReview(action:string,paper:PaperStudyData,paragraph:PaperParagraph,draft:PaperDraft){
 const full=paperReviewerPrompt(action,paper,paragraph,draft),template=paperTemplate(draft.slotTemplate),fields=currentPaperSlots(draft);
 try{for(const value of [action,paper.title,paper.paperId,paragraph.id,paragraph.rawEn,draft.summaries[paragraph.id]??'',...fields.map(field=>field.value)])studyText(value,'paper-review-input',Number.MAX_SAFE_INTEGER,true);}catch{throw new Error('当前审阅内容含不支持的控制字符或不完整字符，请核对原文后重试；没有发送请求，完整草稿保留。');}
 let scale=1;
 for(let attempt=0;attempt<8;attempt++){
  const changed:string[]=[],clip=(label:string,value:string,max:number)=>{const next=excerpt(value,Math.floor(max*scale));if(next!==value)changed.push(label);return next;};
  const title=clip('论文标题',paper.title,300),rawEn=clip('当前微段',paragraph.rawEn,3400),summary=clip('段落概括',draft.summaries[paragraph.id]??'',1200);
  const values=Object.fromEntries(fields.map(field=>[field.key,clip(field.label,field.value,600)]));
  const subset:PaperDraft={...draft,summaries:{[paragraph.id]:summary},...(template.id==='empirical'?{slots:values}:{templateSlots:{[template.id]:values}})};
  const prompt=paperReviewerPrompt(clip('审阅任务',action,160),{...paper,title},{...paragraph,rawEn},subset);
  const context={id:`paper:${paper.paperId}:${paragraph.id}`,title,question:rawEn,learnerAnswer:currentPaperSlots(subset).map(field=>`${field.label}：${field.value}`).join('\n'),truncated:changed.length>0};
  // Reserve room for request ID, provider, model and revision without changing the server schema.
  if(prompt.length<=12000&&context.id.length<=4000&&context.learnerAnswer.length<=4000&&JSON.stringify({context,messages:[{role:'user',content:prompt}]}).length<=44000){
   return {prompt,context,truncated:changed.length>0,notice:changed.length?`本次仅审阅节选（${[...new Set(changed)].join('、')}）。未发送部分不会被审阅；完整草稿仍保留。`:'本次审阅当前微段和当前模板主线，不包含其他模板或全文。',fullPrompt:full};
  }
  scale*=0.65;
 }
 throw new Error('本次审阅内容无法形成有效请求，请缩小微段或主线范围后再试；完整草稿保留。');
}
