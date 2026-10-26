'use client';
import type {ReactNode} from 'react';
import type {FlashcardAnswerView} from '../../domain/flashcard-reading';

/** A complete answer stays visible; optional details never remove the original. */
export function FlashcardAnswer({view,renderText}:{view:FlashcardAnswerView;renderText:(value:string)=>ReactNode}) {
    return <div className="flashcard-answer w-full" style={{overflowWrap:'anywhere',minWidth:0}}>
        {view.compact && <p className="flashcard-answer-label study-meta">关键要点</p>}
        <div className="flashcard-answer-primary">{renderText(view.primary)}</div>
        {view.compact && <details className="flashcard-answer-details mt-4 text-left">
            <summary>查看完整说明</summary>
            <div className="flashcard-answer-full mt-3">{renderText(view.full)}</div>
        </details>}
    </div>;
}
