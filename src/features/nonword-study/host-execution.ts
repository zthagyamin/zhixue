import {useLayoutEffect,useState} from 'react';
import type {NonWordRuntimePort} from '../../application/nonword-study';
import {createNonWordExecutionCoordinator} from '../../application/nonword-study';

type Options={
    current:()=>NonWordRuntimePort|null;
    primary:()=>NonWordRuntimePort|null;
    createChild:(parentId:string,instanceId:string)=>Promise<NonWordRuntimePort>;
};
/** Mutable React composition ports; evidence logic remains in its serial application. */
export function useHostExecution(options:Options,bindingKey:string){
    const [holder]=useState(()=>{
      let live=options;
      const controller=createNonWordExecutionCoordinator({
        current:()=>live.current(),primary:()=>live.primary(),
        createChild:(parent,id)=>live.createChild(parent,id),newId:()=>crypto.randomUUID(),
        readInstance:parent=>parent.practice?.snapshot()?.execution?.prepared,
        rememberInstance:async(parent,pointer)=>{
            if(!parent.practice)throw Error('当前入口还不能保存补练执行证据，原代码已保留。');
            await parent.practice.recordPrepared(pointer);
        },
        recordReport:async(runtime,report,output)=>{
            if(!runtime.practice)throw Error('当前入口还不能保存运行详情，原代码已保留。');
            await runtime.practice.recordCodeReport(report,output);
        }
      });
      return {controller,update:(next:Options)=>{live=next;}};
    });
    useLayoutEffect(()=>{holder.update(options);},[holder,options,bindingKey]);
    return holder.controller;
}
