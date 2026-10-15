import type {PaperStudyData,PaperParagraph,PaperDraft} from '../paper-study';
import type {StudyAIService} from '../../src/application/ai';
import type {StudyAISettings} from '../../src/domain/ai';
// @ts-expect-error TS5097: standalone Node regression tests.
import {createPaperReviewService} from '../../src/application/paper-review/index.ts';
// @ts-expect-error TS5097: standalone Node regression tests.
import {buildPaperReview} from '../paper-review-budget.ts';
// @ts-expect-error TS5097: standalone Node regression tests.
import {currentPaperSlots,paperTemplate} from '../paper-slot-templates.ts';
type WorkshopSource={owner:string;library:string;paper:PaperStudyData;paragraph:PaperParagraph;draft:PaperDraft;isCurrent?:()=>boolean};
/** Compatibility assembly: the application receives preparation and existing transport ports. */
export function createPaperWorkshopReview(options:{source:()=>WorkshopSource;settings:()=>StudyAISettings|null;ai?:Pick<StudyAIService,'chat'>;requestId?:()=>string}){
    return createPaperReviewService({
        ai:options.ai,settings:options.settings,requestId:options.requestId??(()=>crypto.randomUUID()),
        prepare:action=>{
            const source=options.source();
            if(!source.paragraph.rawEn.trim()||!source.paper.sections.some(section=>section.paragraphs.some(paragraph=>paragraph.id===source.paragraph.id&&paragraph.rawEn===source.paragraph.rawEn)))
                throw Error('当前微段缺少可核对的原文，请补充来源后再审阅；没有发送请求，完整草稿保留。');
            return buildPaperReview(action,source.paper,source.paragraph,source.draft);
        },
        currentScope:()=>{
            const source=options.source();
            if(source.isCurrent?.()===false)return null;
            return JSON.stringify([source.owner,source.library,source.paper.paperId,source.paper.origin?.version,source.paper.title,
                source.draft.position,source.paragraph.id,source.paragraph.rawEn,paperTemplate(source.draft.slotTemplate).id,
                source.draft.summaries[source.paragraph.id]??'',currentPaperSlots(source.draft)]);
        },
    });
}

/** Host callback identity may change without changing the source scope. */
export function createPaperWorkshopReviewGuard(){
    let latest:(()=>boolean)|undefined;
    return {
        check:()=>latest?.()!==false,
        update:(callback:(()=>boolean)|undefined)=>{latest=callback;},
    };
}
