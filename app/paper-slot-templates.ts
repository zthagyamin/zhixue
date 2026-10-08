export type PaperTemplateId='empirical'|'theory'|'free';
export type PaperSlotTemplate={id:PaperTemplateId;label:string;description:string;fields:readonly {key:string;label:string}[]};
export const PAPER_SLOT_TEMPLATES:readonly PaperSlotTemplate[]=[
 {id:'empirical',label:'实验实证型',description:'围绕研究问题、方法、证据和适用边界整理。',fields:[{key:'motivation',label:'研究问题'},{key:'baselineFailure',label:'基线为何不足'},{key:'coreMechanism',label:'核心机制'},{key:'keyEvidence',label:'关键证据'},{key:'limitations',label:'边界与局限'}]},
 {id:'theory',label:'理论概念型',description:'围绕论题、既有观点、论证或推导和结论整理。',fields:[{key:'thesis',label:'核心论题'},{key:'prior',label:'既有观点'},{key:'argument',label:'新论证 / 推导'},{key:'conclusion',label:'结论与启示'}]},
 {id:'free',label:'自由三槽',description:'用三个问题整理，不限定学科或研究方法。',fields:[{key:'problem',label:'它解决了什么'},{key:'approach',label:'怎么解决的'},{key:'limits',label:'有何局限'}]},
];
export type PaperTemplateState={slots:Partial<Record<string,string>>;slotTemplate?:PaperTemplateId;templateSlots?:Partial<Record<PaperTemplateId,Record<string,string>>>};
export function paperTemplate(id:unknown):PaperSlotTemplate{return PAPER_SLOT_TEMPLATES.find(t=>t.id===id)??PAPER_SLOT_TEMPLATES[0];}
export function currentPaperSlots(draft:PaperTemplateState){const template=paperTemplate(draft.slotTemplate),values=template.id==='empirical'?draft.slots:draft.templateSlots?.[template.id]??{};return template.fields.map(field=>({...field,value:typeof values[field.key]==='string'?values[field.key]!:''}));}
export function setPaperTemplate<T extends PaperTemplateState>(draft:T,id:unknown):T{if(!PAPER_SLOT_TEMPLATES.some(t=>t.id===id))return draft;return {...draft,slotTemplate:id as PaperTemplateId};}
export function setPaperSlot<T extends PaperTemplateState>(draft:T,key:string,value:string):T{
 const template=paperTemplate(draft.slotTemplate);if(!template.fields.some(field=>field.key===key)||typeof value!=='string'||value.length>3000)return draft;
 return template.id==='empirical'?{...draft,slots:{...draft.slots,[key]:value}}:{...draft,templateSlots:{...draft.templateSlots,[template.id]:{...draft.templateSlots?.[template.id],[key]:value}}};
}
export function paperOutlineMarkdown(draft:PaperTemplateState){
 const current=paperTemplate(draft.slotTemplate),active=currentPaperSlots(draft).map(field=>`## ${field.label}\n\n${field.value||'尚未填写'}\n`).join('\n');
 const other=PAPER_SLOT_TEMPLATES.filter(t=>t.id!==current.id).map(t=>({template:t,fields:currentPaperSlots({...draft,slotTemplate:t.id}).filter(field=>field.value.trim())})).filter(entry=>entry.fields.length);
 return `整理模板：${current.label}\n\n`+active+(other.length?'\n## 其他模板中的草稿\n\n'+other.map(({template,fields})=>`### ${template.label}\n\n`+fields.map(field=>`#### ${field.label}\n\n${field.value}\n`).join('\n')).join('\n'):'');
}
export function paperReviewerActions(id:unknown):readonly string[]{return paperTemplate(id).id==='empirical'?['反事实消融','Tensor Shape 推导','主张与证据对齐','章节桥接']:paperTemplate(id).id==='theory'?['论证结构','概念澄清','反例与适用边界','章节桥接']:['核心问题','解决思路','证据与局限','章节桥接'];}
export function paperSelfcheckLabels(id:unknown):readonly string[]{return paperTemplate(id).id==='empirical'?['研究问题','机制解释','证据条件','局限识别','闭卷重建']:paperTemplate(id).id==='theory'?['核心论题','论证依据','推导步骤','结论边界','闭卷重述']:['问题概括','解决思路','局限识别'];}
