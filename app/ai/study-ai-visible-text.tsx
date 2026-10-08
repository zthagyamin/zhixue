import {isValidElement,type ReactNode} from 'react';
import {MathText} from '../math-text';

/** Read visible card text without serializing component props or hidden source descriptors. */
export function studyAIVisibleText(node:ReactNode):string{
 if(typeof node==='string'||typeof node==='number')return String(node);
 if(Array.isArray(node))return node.map(studyAIVisibleText).filter(Boolean).join(' ');
 if(isValidElement<{children?:ReactNode;text?:string}>(node)){
   if(node.type===MathText)return typeof node.props.text==='string'?node.props.text:'';
   return studyAIVisibleText(node.props.children);
 }
 return '';
}
