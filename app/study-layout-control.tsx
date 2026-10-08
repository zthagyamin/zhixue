'use client';
import {useLayoutEffect,useSyncExternalStore} from 'react';
import {applyStudyLayout,studyLayoutPreference,serverStudyLayout,type StudyLayout} from './study-layout';
import './study-layout.css';
export function StudyLayoutRuntime(){const mode=useSyncExternalStore(studyLayoutPreference.subscribe,studyLayoutPreference.getSnapshot,serverStudyLayout);useLayoutEffect(()=>applyStudyLayout(document,mode),[mode]);return null;}
export function StudyLayoutControl(){const mode=useSyncExternalStore(studyLayoutPreference.subscribe,studyLayoutPreference.getSnapshot,serverStudyLayout);return <label className="study-layout-control"><span>页面布局</span><select aria-label="选择网站布局" value={mode} onChange={event=>studyLayoutPreference.set(event.target.value as StudyLayout)}><option value="auto">自动适应</option><option value="desktop">电脑版</option><option value="tablet">平板版</option><option value="mobile">手机版</option></select></label>;}
