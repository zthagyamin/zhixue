export type SourceReadFrame={ready:boolean;current:()=>boolean};
export type SourceReaderPorts<Frame extends SourceReadFrame,Input,Value>={
  capture:()=>Frame;read:(frame:Frame,input:Input,signal:AbortSignal)=>Promise<Value>;
  publish:(value:Value,frame:Frame,input:Input)=>void;error:(error:unknown,frame:Frame)=>void;busy:(value:boolean)=>void;
};
/** Latest request wins presentation. Each response keeps its original frame and cancellation signal. */
export function createSourceReader<Frame extends SourceReadFrame,Input,Value>(ports:SourceReaderPorts<Frame,Input,Value>){
  type Job={frame:Frame;controller:AbortController};let active:Job|null=null,disposed=false;
  const current=(job:Job)=>!disposed&&active===job&&!job.controller.signal.aborted&&job.frame.current();
  const cancel=()=>{const old=active;active=null;if(old){old.controller.abort();if(old.frame.current())ports.busy(false);}};
  return{
    async read(input:Input,options:{strict?:boolean}={}):Promise<Value|null>{
      const frame=ports.capture();if(disposed||!frame.ready||!frame.current())return null;
      cancel();const job={frame,controller:new AbortController()};active=job;ports.busy(true);
      try{const value=await ports.read(frame,input,job.controller.signal);if(!current(job)){if(options.strict)throw Error('study-workspace-changed');return null;}ports.publish(value,frame,input);return value;}
      catch(error){if(current(job))ports.error(error,frame);if(options.strict)throw error;return null;}
      finally{if(active===job){active=null;if(!disposed&&frame.current())ports.busy(false);}}
    },cancel,dispose(){cancel();disposed=true;},
  };
}
