'use client';
import type {ReactNode} from 'react';
import {MathText} from './math-text';
import {contextPieces, type WordContext} from './word-context-model';

/** Build elements from literal strings; never evaluate source HTML or source links. */
export function WordContextView({model, concealed}: {model: WordContext; concealed: boolean}) {
  return <blockquote className="study-context-example" aria-label={concealed ? '回想空缺词的原文语境' : '原文语境'}>
    {contextPieces(model, concealed).map((piece, index) => {
      if (piece.gap) return <span key={index} className="study-context-gap" role="img" aria-label="待回想的词"><span aria-hidden="true">______</span></span>;
      let content: ReactNode = piece.kind === 'math' ? <MathText text={piece.text}/> : piece.kind === 'code' ? <code>{piece.text}</code> : piece.text;
      if (piece.marks.includes('em')) content = <em>{content}</em>;
      if (piece.marks.includes('strong')) content = <strong>{content}</strong>;
      if (piece.answer) content = <mark className="study-context-answer">{content}</mark>;
      return <span key={index}>{content}</span>;
    })}
  </blockquote>;
}
