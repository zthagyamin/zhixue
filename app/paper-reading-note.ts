// @ts-expect-error TS5097: standalone Node regression tests.
import {allPaperVocabulary,exportPaperVocabulary,type PaperStudyData,type PaperDraft} from './paper-study.ts';
// @ts-expect-error TS5097: standalone Node regression tests.
import {paperOutlineMarkdown} from './paper-slot-templates.ts';
export function readingNoteMarkdown(paper:PaperStudyData,draft:PaperDraft){const words=allPaperVocabulary(draft),origin=paper.origin,source=origin?.url??origin?.path??origin?.filename??paper.sourceNote??'导入材料';return`# ${paper.title}\n\n来源：${source}\n\n学习者阅读笔记；自评不等于正式掌握。\n\n`+paperOutlineMarkdown(draft)+'\n## 逐段概括\n\n'+paper.sections.flatMap(s=>s.paragraphs.filter(p=>draft.summaries[p.id]?.trim()).map(p=>`### ${s.title}${p.pageNumber?` · PDF 第 ${p.pageNumber} 页`:''}\n\n${draft.summaries[p.id]}\n`)).join('\n')+(words.length?'\n## 本次选词\n\n'+exportPaperVocabulary(words):'')+'\n## 自检\n\n'+Object.entries(draft.selfcheck).map(([k,v])=>`- ${k}：${v}`).join('\n');}
