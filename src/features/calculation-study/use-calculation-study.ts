'use client';
import {useEffect,useRef,useState} from 'react';
import type {NonWordLearningPort} from '../../application/nonword-study';
import type {MathStudyResultV1} from '../../application/math-study';
import type {PracticeEvidenceDiagnostic} from '../../domain/practice-evidence';

/** Only source-bound host capabilities enable step and variant interactions. */
export function useCalculationStudy(practice:NonWordLearningPort['practice'],sourceVersion:string|undefined,identity:string){
    const calculation=practice?.calculation;
    const support=calculation?.support;
    const variant=calculation?.activeVariant?.()??null;
    const step=!variant&&support?.schemaVersion===2?support.step:undefined;
    type View={identity:string;practice:NonWordLearningPort['practice'];text:string;diagnostic?:PracticeEvidenceDiagnostic;error:string};
    const edited=useRef({identity,practice,value:false});
    const validSnapshot=()=>{
        const saved=practice?.snapshot();
        return saved&&(!sourceVersion||saved.binding.contentHash===sourceVersion)?saved:null;
    };
    const initial=():View=>{
        const saved=validSnapshot(),input=saved?.calculation?.stepInput,d=saved?.calculation?.diagnostic;
        return{identity,practice,text:input?.text??'',error:'',...(d&&d.sourceVersion===saved?.binding.contentHash
            &&d.stepRevision===input?.revision&&d.stepId===step?.stepId?{diagnostic:d}:{})};
    };
    const [state,setState]=useState<View>(initial);
    const view=state.identity===identity&&state.practice===practice?state:initial();
    useEffect(()=>{
        let live=true;
        const restore=()=>{
            if(!live)return;
            const saved=practice?.snapshot();
            if(!saved||sourceVersion&&saved.binding.contentHash!==sourceVersion)return;
            const input=saved.calculation?.stepInput,d=saved.calculation?.diagnostic;
            setState(previous=>{
                const base=previous.identity===identity&&previous.practice===practice?previous:{identity,practice,text:'',error:''};
                return{...base,error:'',...(input&&!(edited.current.identity===identity&&edited.current.practice===practice&&edited.current.value)?{text:input.text}:{}),
                    ...(d&&d.sourceVersion===saved.binding.contentHash&&d.stepRevision===input?.revision&&d.stepId===step?.stepId?{diagnostic:d}:{})};
            });
        };
        if(calculation)void practice?.refresh().then(restore).catch(reason=>{
            if(live)setState(previous=>({...(previous.identity===identity&&previous.practice===practice?previous:{identity,practice,text:''}),
                error:reason instanceof Error?reason.message:'步骤恢复尚未完成。'}));
        });
        return()=>{live=false;};
    },[practice,calculation,sourceVersion,identity,step?.stepId]);
    function accept(result:MathStudyResultV1){
        const raw=practice?.snapshot(),saved=validSnapshot();
        if(sourceVersion&&result.sourceVersion!==sourceVersion||raw&&!saved
            ||saved&&(result.attemptId!==saved.attemptId||result.sourceVersion!==saved.binding.contentHash))return false;
        const d=result.step;
        if(d){
            if(!step||d.sourceVersion!==result.sourceVersion||d.answerRevision!==result.answerRevision
                ||d.stepId!==step.stepId||saved&&d.stepRevision!==saved.calculation?.stepInput.revision)return false;
            setState({...view,diagnostic:d});
        }
        return true;
    }
    return{calculation,support,variant,step,stepText:view.text,diagnostic:view.diagnostic,recoveryError:view.error,accept,
        editStep:(value:string)=>{
            edited.current={identity,practice,value:true};setState({...view,text:value});
            practice?.stageStep?.(value);
        },
        saveStep:async()=>{if(step&&view.text.trim())await practice?.saveStep(view.text);}};
}
