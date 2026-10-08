import {useState,useLayoutEffect} from 'react';
import type {HostDriver,HostProps,HostGradeOptions} from './host-contracts';
import type {FSRSRating} from '../../domain/assessment';
type View={purpose:'first'|'guided'|'remediation';instanceId?:string};
type Options={current:()=>HostDriver|null;primary:()=>HostDriver|null;valid:()=>boolean;
    pendingGrade:()=>Promise<void>|null;flush:()=>Promise<void>;ensureOutcome:(parent:HostDriver)=>Promise<void>;
    readView:()=>View;persistView:(view:View)=>Promise<void>;
    createChild:(parentId:string,instanceId:string)=>Promise<HostDriver>;activate:(child:HostDriver)=>Promise<void>;newId:()=>string};
const prefix='math-variant-v1:';
export function hostVariantSeed(instanceId?:string):number|null{
    const match=instanceId?.match(/^math-variant-v1:(\d+):[^:]+$/u),seed=match?Number(match[1]):NaN;
    return Number.isSafeInteger(seed)&&seed>=0&&seed<=0xffffffff?seed:null;
}
/** V1 instanceId stores the creation intent; no new checkpoint fields. */
export function createHostVariantCoordinator(initial?:Options){
    let options=initial!,job:Promise<void>|null=null;
    const check=()=>{if(!options.valid())throw Error('来源或账号已切换，变式未应用。');};
    async function prepare(parent:HostDriver,instanceId:string){
        check();const seed=hostVariantSeed(instanceId),attempt=parent.runtime.session.snapshot(),calculation=parent.runtime.practice?.calculation;
        if(seed===null||!attempt?.submitted||!calculation?.getVariant)throw Error('来源尚未提供经审定的变式。');
        const approved=await calculation.getVariant(seed);check();if(!approved)throw Error('本题没有可用的经审定变式。');
        const child=await options.createChild(attempt.attemptId,instanceId);check();
        if(!child.runtime.practice?.calculation?.prepareVariant)throw Error('当前入口尚不能保存变式，首轮答案保留。');
        await child.runtime.practice.calculation.prepareVariant(approved.descriptor);check();return child;
    }
    return {
        update(next:Options){options=next;},
        async restore(parent:HostDriver,instanceId:string){await options.ensureOutcome(parent);check();return prepare(parent,instanceId);},
        start(seed:number):Promise<void>{
            if(job)return job;
            job=(async()=>{
                check();await options.pendingGrade();check();await options.flush();check();
                const parent=options.current(),attempt=parent?.runtime.session.snapshot();
                if(!parent||parent!==options.primary()||!attempt?.submitted||attempt.checkpoint.mode!=='calculation'
                    ||parent.runtime.practice?.calculation?.activeVariant?.())throw Error('请先完成当前首轮核对，再开始变式。');
                if(attempt.evaluation.status!=='resolved')throw Error('首轮答案仍待核对，暂不能开始变式。');
                await options.ensureOutcome(parent);check();
                if(!Number.isSafeInteger(seed)||seed<0||seed>0xffffffff)throw Error('变式种子无效。');
                const previous=options.readView(),instanceId=previous.purpose==='remediation'&&hostVariantSeed(previous.instanceId)!==null
                    ?previous.instanceId!:prefix+seed+':'+options.newId();
                await options.persistView({purpose:'remediation',instanceId});check();
                const child=await prepare(parent,instanceId);check();await options.activate(child);
            })().finally(()=>{job=null;});
            return job;
        }
    };
}
type Ref<T>={current:T};
type HostOptions={props:HostProps;activeDriver:Ref<HostDriver|null>;firstDriver:Ref<HostDriver|null>;
    live:Ref<boolean>;binding:Ref<string>;continuationLock:Ref<boolean>;gradeTask:Ref<Promise<void>|null>;
    view:Ref<View>;values:Ref<Record<string,unknown>>;shownReference:Ref<boolean>;groupBase:Ref<number>;
    intent:'review'|'learn';flush:()=>Promise<void>;persistView:(patch:View&{lessonStep?:'independent'})=>Promise<void>;
    grade:(rating:FSRSRating,options?:HostGradeOptions)=>Promise<void>;
    clock:{deactivate:(driver:HostDriver)=>void;activate:(driver:HostDriver)=>unknown};
    state:{driver:(driver:HostDriver)=>void;lesson:()=>void;generation:()=>void;status:(driver:HostDriver)=>Promise<void>;busy:(busy:boolean)=>void;error:(error:string)=>void}};
/** React adapter keeps common host state and clock transitions together. */
export function useHostVariant(input:HostOptions){
    const {props,activeDriver:activeRef,firstDriver:firstRef,values:valuesRef,shownReference:referenceRef,groupBase:groupRef}=input;
    const options:Options={current:()=>activeRef.current,primary:()=>firstRef.current,
        valid:()=>input.live.current&&input.binding.current===props.bindingKey&&!input.continuationLock.current,
        pendingGrade:()=>input.gradeTask.current,flush:input.flush,readView:()=>input.view.current,
        persistView:patch=>input.persistView({...patch,lessonStep:'independent'}),newId:()=>crypto.randomUUID(),
        createChild:(parent,id)=>props.createDriver('remediation',input.intent,parent,id),
        async ensureOutcome(parent){
            const attempt=parent.runtime.session.snapshot()!;
            if(attempt.evaluation.status!=='resolved')throw Error('首轮答案仍待核对，暂不能开始变式。');
            if(!props.temporary&&parent.runtime.purpose==='first'&&attempt.formal?.status!=='linked')await input.grade(attempt.evaluation.rating,{deferAdvance:true});
            const saved=parent.runtime.session.snapshot();
            if(saved?.evaluation.status!=='resolved'||!props.temporary&&parent.runtime.purpose==='first'&&saved.formal?.status!=='linked')throw Error('首轮结果尚未可靠保存。');
        },
        async activate(current){
            const old=activeRef.current;if(old)input.clock.deactivate(old);
            activeRef.current=current;input.clock.activate(current);valuesRef.current=current.restore();
            referenceRef.current=false;input.state.driver(current);input.state.lesson();
            groupRef.current=await current.runtime.groupSeconds?.()??0;
            input.state.generation();await input.state.status(current);
        }};
    const [holder]=useState(()=>createHostVariantCoordinator());
    useLayoutEffect(()=>{holder.update(options);});
    return {...holder,async start(seed:number){
        input.state.busy(true);input.state.error('');
        try{await holder.start(seed);}
        catch(reason){if(input.live.current)input.state.error(reason instanceof Error?reason.message:'变式尚未打开，首轮答案保留。');throw reason;}
        finally{if(input.live.current)input.state.busy(false);}
    }};
}
export async function restoreHostAuxiliary(parent:HostDriver,view:View|undefined,intent:'review'|'learn',create:HostProps['createDriver'],variant:ReturnType<typeof useHostVariant>){
    if(!view?.purpose||view.purpose==='first'||!view.instanceId)return parent;
    if(hostVariantSeed(view.instanceId)!==null)return variant.restore(parent,view.instanceId);
    const saved=parent.runtime.session.snapshot()!;
    return create(view.purpose,intent,saved.submitted?saved.attemptId:undefined,view.instanceId);
}
