'use client';
import {useMemo,useSyncExternalStore} from 'react';
import {createSubjectRoundSessions} from './subject-round-resume';
export function useSubjectRoundSessions(owner:string,day:string){
 const session=useMemo(()=>createSubjectRoundSessions(),[owner,day]);
 useSyncExternalStore(session.subscribe,session.getSnapshot,session.getSnapshot);
 return {subjectRounds:session.getRounds(),setSubjectRounds:session.set,activateSubjectRound:session.activate,getSubjectRound:session.get,getVisibleSubjectRound:session.getVisible};
}
