'use client';
import {Component,lazy,Suspense,type ComponentType,type LazyExoticComponent,type ReactNode} from 'react';
import type {PluginRenderProps,StudyPlugin} from './registry';
import {createPluginModuleLoader} from './plugin-module-loader';
import {PluginContentBoundary} from '../plugin-content-boundary';
import type {PluginType} from '../plugin-routing';

/** Created once at registration time. Retry resets React.lazy's cached rejection. */
export function createLazyComponent<P extends object>(load:()=>Promise<{default:ComponentType<P>}>,label:string,renderFallback?:(props:P,retry?:()=>void)=>ReactNode){
 type State={failed:boolean;Loaded:LazyExoticComponent<ComponentType<P>>};
 let SharedLoaded=lazy(load);
 return class DeferredView extends Component<P,State>{
  state:State={failed:false,Loaded:SharedLoaded};
  static getDerivedStateFromError(){return{failed:true};}
  retry=()=>{SharedLoaded=lazy(load);this.setState({failed:false,Loaded:SharedLoaded});};
  render(){
   if(this.state.failed)return renderFallback?renderFallback(this.props,this.retry):<div role="alert" className="study-feedback"><p>{label}暂时无法加载，请检查网络后重试。</p><button type="button" className="study-secondary-action" onClick={this.retry}>重新加载</button></div>;
   const Loaded=this.state.Loaded as ComponentType<P>;
   return <Suspense fallback={renderFallback?renderFallback(this.props):<p role="status" className="study-feedback">正在加载{label}…</p>}><Loaded {...this.props}/></Suspense>;
  }
 };
}
export function createLazyPlugin<T>(metadata:Pick<StudyPlugin<T>,'id'|'name'|'description'>,load:()=>Promise<StudyPlugin<T>>):StudyPlugin<T>{
 const loadModule=createPluginModuleLoader(metadata.id,load);
 const View=createLazyComponent<PluginRenderProps<T>>(async()=>({default:(await loadModule()).renderUI}),metadata.name);
 const mode=metadata.id.replace('@zhixue/plugin-','') as PluginType;
 const checked=metadata.id.startsWith('@zhixue/plugin-')&&['three-stage','quiz','recall','calculation','code','flashcard','spelling','paper'].includes(mode);
 // Third-party descriptors have their own data contracts; do not apply an invented schema.
 return {...metadata,renderUI:props=>checked?<PluginContentBoundary {...props} mode={mode} View={View}/>:<View {...props}/>};
}
