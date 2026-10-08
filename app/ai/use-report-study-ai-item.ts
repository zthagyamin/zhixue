'use client';
import {useEffect} from 'react';
import {useStudyAIContext} from '../components/ai-sidebar/study-ai-workspace';
import type {StudyAIContext} from './study-ai-types';
import type {PluginContext} from '../plugins/registry';

/** Explicit visible exercise fields only; never serialize the source descriptor or draft key. */
export function useReportStudyAIItem(context:PluginContext|undefined,fields:Omit<StudyAIContext,'id'|'title'>,active=true){
 const {setContext,setAssistance,clearContext}=useStudyAIContext();
 const observer=context?.draft?.assistance;
 const serialized=JSON.stringify(context?.aiItem?{...context.aiItem,...fields}:null);
 useEffect(()=>{if(active&&serialized!=='null'){const item=JSON.parse(serialized) as StudyAIContext;setContext(item);return()=>clearContext(item.id);}},[active,serialized,setContext,clearContext]);
 useEffect(()=>{if(!active)return;setAssistance(observer);return()=>setAssistance(undefined);},[active,observer,setAssistance]);
}
