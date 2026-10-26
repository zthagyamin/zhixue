'use client';
import {useEffect,useLayoutEffect,useRef,useState,useSyncExternalStore} from 'react';
import type {PaperStudyData} from '../paper-study';
import {paperFingerprint} from '../paper-draft-store';
import type {PaperServices} from '../plugins/plugin-paper';
import {useOptionalStudyAIWorkspace} from '../components/ai-sidebar/study-ai-workspace';
import {registerStudyNavigationGuard} from '../study-navigation-guard';
import {MathText} from '../math-text';
import {PaperSourceText} from '../../src/features/paper-reading/source-text';
import {PaperReadingQuestion,paperReadingMessage} from '../../src/features/paper-reading';
import {paperReadingUnit,type PaperReadingUnit,type PaperReadingUnitV1,type PreparedPaperTask} from '../../src/domain/paper-reading';
import {createPaperReadingSession,type PaperReadingSession} from '../../src/application/paper-reading';
import {createPaperReadingRemote,createLocalPaperReadingAi} from '../../src/infrastructure/paper-reading';
import {canonicalAttemptJson} from '../../src/domain/learning-attempt';
import {studyHash} from '../../src/domain/sync';
import {createPaperReadingStore} from './store';
import {PaperReviewCandidate} from './candidate';
import {loadPreparedPaperTask,PreparedQuestionTools} from './prepared';

type Props={restoredUnit?:PaperReadingUnitV1;paper:PaperStudyData;unit:PaperReadingUnit;services:PaperServices;onSaving:(value:boolean)=>void;onError:(value:string)=>void;onSession:(session:PaperReadingSession|null)=>void;onContinue:()=>void};
export function PaperQuestionEntry({paper,unit,services,restoredUnit,onSaving,onError,onSession,onContinue}:Props){
    const ai=useOptionalStudyAIWorkspace(),current=useRef({services,ai});
    useLayoutEffect(()=>{current.current={services,ai};},[services,ai]);
    const [preparedVersion,setPreparedVersion]=useState(0);
    const bound=JSON.stringify([services.owner,services.library,paper.paperId,unit.position,unit.paragraphs.map(p=>p.id),restoredUnit?.unitId,preparedVersion]);
    const [loaded,setLoaded]=useState<{bound:string;session:PaperReadingSession}|null>(null),[error,setError]=useState('');
    const [baseUnit,setBaseUnit]=useState<PaperReadingUnitV1|null>(null);
    const [prepared,setPrepared]=useState<PreparedPaperTask|null>(null);
    const paragraphsKey=JSON.stringify(unit.paragraphs.map(p=>({id:p.id,rawEn:p.rawEn,...(p.pageNumber?{pageNumber:p.pageNumber}:{})}))),sectionId=unit.sectionId;
    useEffect(()=>{
        let active=true,session:PaperReadingSession|undefined;onSaving(true);
        const isCurrent=()=>active&&current.current.services.owner===services.owner&&current.current.services.library===services.library&&current.current.services.isCurrent?.()!==false;
        const localAi=createLocalPaperReadingAi(()=>current.current.ai?{service:current.current.ai.service,settings:current.current.ai.settings}:null,
            isCurrent);
        async function open(){
            const fingerprint=await paperFingerprint(paper),paragraphs=JSON.parse(paragraphsKey);
            const source={ownerId:services.owner,libraryId:services.library,materialFingerprint:fingerprint,sourceVersion:paper.origin?.version??fingerprint,sectionId,paragraphs};
            const sourceMatches=restoredUnit&&canonicalAttemptJson(restoredUnit.source)===canonicalAttemptJson(source);
            const goal=sourceMatches?restoredUnit!.goal:'解释当前原文的关键概念、方法或机制';
            const base=paperReadingUnit({schemaVersion:1,unitId:'paper-unit:'+await studyHash({source,goal,title:paper.title}),title:paper.title,goal,source});
            const preset=await loadPreparedPaperTask({ownerId:services.owner,libraryId:services.library},base);
            const matchingRestore=preparedVersion===0&&restoredUnit&&canonicalAttemptJson(restoredUnit.source)===canonicalAttemptJson(base.source);
            const readingUnit=matchingRestore?paperReadingUnit(restoredUnit!):preset?paperReadingUnit({...base,unitId:'paper-unit:'+await studyHash({baseUnitId:base.unitId,preparedRecipe:preset.recipeHash})}):base;
            if(!active)return;
            const remote=services.library.startsWith('account:')?createPaperReadingRemote({scope:source,isCurrent}):undefined;
            session=createPaperReadingSession({unit:readingUnit,store:createPaperReadingStore(),remote,localAi:remote?undefined:localAi,makeId:()=>crypto.randomUUID(),now:()=>new Date(),
                isCurrent});
            setBaseUnit(base);setPrepared(preset);setLoaded({bound,session});setError('');onSession(session);await session.load();
        }
        void open().catch(reason=>{if(active){setError(reason instanceof Error?reason.message:'paper-reading-load-unavailable');onSaving(false);}});
        return()=>{active=false;session?.dispose();onSession(null);onSaving(false);};
    },[paper,paragraphsKey,sectionId,services.owner,services.library,bound,onSaving,onSession,preparedVersion,restoredUnit]);
    return <>{error&&<p role="alert">{paperReadingMessage(error)}</p>}{loaded?.bound===bound?<QuestionSession session={loaded.session} paper={paper} services={services} prepared={prepared}
        onSaving={onSaving} onError={onError} onContinue={onContinue}/>:!error?<p role="status">正在恢复问答…</p>:null}
        {baseUnit&&loaded?.bound===bound&&<PreparedQuestionTools unit={baseUnit} scope={{ownerId:services.owner,libraryId:services.library}}
            beforeChange={async()=>{await loaded.session.flush();if(loaded.session.snapshot().busy)throw Error('请等待本次核对结束后再导入预备题。');}}
            onChange={()=>setPreparedVersion(value=>value+1)}/>}</>;
}
function QuestionSession({session,paper,services,prepared,onSaving,onError,onContinue}:{session:PaperReadingSession;paper:PaperStudyData;services:PaperServices;prepared:PreparedPaperTask|null;onSaving:(value:boolean)=>void;onError:(value:string)=>void;onContinue:()=>void}){
    const state=useSyncExternalStore(session.subscribe,session.snapshot,session.snapshot);
    useEffect(()=>{
        const update=()=>{const next=session.snapshot();onSaving(!next.ready||next.saving);onError(next.error);};update();
        const unsubscribe=session.subscribe(update);
        const unregister=registerStudyNavigationGuard({message:()=>session.snapshot().saving||session.snapshot().error?'阅读答案尚未可靠保存，请先重试保存。':null,
            onLeave:()=>session.dispose(),version:()=>session.snapshot()});
        const beforeUnload=(event:BeforeUnloadEvent)=>{if(session.snapshot().saving||session.snapshot().error){event.preventDefault();event.returnValue='';}};
        window.addEventListener('beforeunload',beforeUnload);
        return()=>{unsubscribe();unregister();window.removeEventListener('beforeunload',beforeUnload);onSaving(false);onError('');};
    },[session,onSaving,onError]);
    const act=(promise:Promise<unknown>)=>{void promise.catch(()=>{});};
    return <PaperReadingQuestion state={state} onBegin={()=>act(session.begin(prepared?.task))} onAnswer={text=>act(session.answer(text))} onSubmit={()=>act(session.submit())}
        onReveal={()=>act(session.reveal())} onRetry={()=>act(session.retry())} onRetrySave={()=>act(session.retrySave())} onReloadSaved={()=>act(session.reloadSaved())}
        onAdoptSavedAnswer={()=>act(session.adoptSavedAnswer())}
        onEvaluate={()=>act(session.evaluate())} onSync={()=>act(state.workspace?session.synchronize():session.load())} onContinue={onContinue}
        formalReview={state.workspace?<PaperReviewCandidate paper={paper} workspace={state.workspace} services={services}/>:undefined}
        renderText={text=><PaperSourceText text={text} renderMath={value=><MathText text={value}/>}/>}/>;
}
