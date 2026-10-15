'use client';
import {useEffect,useLayoutEffect,useRef,useState} from 'react';
import type {PaperStudyData} from '../paper-study';
import {paperFingerprint} from '../paper-draft-store';
import type {PaperServices} from '../plugins/plugin-paper';
import {createPaperReadingGroupClock,type PaperReadingGroupClock,type PaperReadingGroupClockState} from '../../src/application/paper-reading-clock';
import {PaperReadingClockControls,PaperReadingClockDetails} from '../../src/features/paper-reading-clock';
import {createPaperReadingClockStore} from './clock';

export function usePaperClock(paper:PaperStudyData,services:PaperServices){
    const current=useRef(services),owned=useRef<PaperReadingGroupClock|null>(null);
    const [state,setState]=useState<PaperReadingGroupClockState|null>(null);
    useLayoutEffect(()=>{current.current=services;},[services]);
    useEffect(()=>{
        let active=true,finalizing=false,clock:PaperReadingGroupClock|undefined,cleanup:(()=>void)|undefined;
        async function open(){
            const materialFingerprint=await paperFingerprint(paper);if(!active)return;
            clock=createPaperReadingGroupClock({scope:{ownerId:services.owner,libraryId:services.library,materialFingerprint},store:createPaperReadingClockStore(),
                now:()=>Date.now(),makeId:()=>crypto.randomUUID(),isCurrent:()=>finalizing||active&&current.current.isCurrent?.()!==false});
            owned.current=clock;
            const update=()=>{if(active)setState(clock!.snapshot());};
            const visibility=()=>{clock!.setVisible(document.visibilityState==='visible'&&document.hasFocus());update();};
            const onPageHide=()=>{clock!.setVisible(false);void clock!.flush().catch(()=>{});};
            const unsubscribe=clock.subscribe(update);clock.setActive(true);visibility();
            const interval=window.setInterval(()=>{update();void clock!.flush().catch(()=>{});},5000);
            document.addEventListener('visibilitychange',visibility);window.addEventListener('focus',visibility);window.addEventListener('blur',visibility);window.addEventListener('pagehide',onPageHide);
            cleanup=()=>{window.clearInterval(interval);unsubscribe();document.removeEventListener('visibilitychange',visibility);window.removeEventListener('focus',visibility);window.removeEventListener('blur',visibility);window.removeEventListener('pagehide',onPageHide);};
            await clock.load();if(!active)return;if(clock.snapshot().groupCompleted)await clock.startGroup().catch(()=>{});if(active)update();
        }
        void open().catch(()=>{if(active&&clock)setState(clock.snapshot());});
        return()=>{
            cleanup?.();
            active=false;finalizing=true;
            if(clock){clock.setActive(false);clock.setVisible(false);void clock.flush().catch(()=>{}).finally(()=>{finalizing=false;clock?.dispose();});}
            if(owned.current===clock)owned.current=null;
        };
    },[paper,services.owner,services.library]);
    const flush=async()=>{const clock=owned.current;if(clock){clock.setActive(false);clock.setVisible(false);await clock.flush();await clock.completeGroup();}};
    const pause=(paused:boolean)=>{const clock=owned.current;if(clock){void clock.pause(paused).catch(()=>{});setState(clock.snapshot());}};
    const retry=()=>{const clock=owned.current;if(clock)void(state?.status==='unavailable'?clock.load().then(()=>clock.snapshot().groupCompleted?clock.startGroup():undefined):clock.flush()).catch(()=>{});};
    return {flush,persist:async()=>{await owned.current?.flush();},controls:state?<PaperReadingClockControls state={state} onPause={pause} onRetry={retry}/>:null,
        details:state?<PaperReadingClockDetails state={state} onStartGroup={()=>{const clock=owned.current;if(clock)void clock.startGroup().catch(()=>{});}}/>:null};
}
