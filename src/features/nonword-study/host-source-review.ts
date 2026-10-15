import type {HostDriver} from './host-contracts';
import {isAttemptRevisionConflict} from '../../application/nonword-study';
type Ports={current:()=>boolean;locked:()=>boolean;lock:(value:boolean)=>void;busy:(value:boolean)=>void;error:(value:string)=>void;
    flush:()=>Promise<unknown>;restore:(values:Record<string,unknown>)=>void;refresh:(driver:HostDriver)=>Promise<unknown>};
/** Reopen source review in place; immutable answers stay in the owning application. */
export async function reviewHostSource(driver:HostDriver|null,ports:Ports){
    if(!driver?.source||!ports.current()||ports.locked())return;
    ports.lock(true);
    ports.busy(true);ports.error('');
    try{
        try{await ports.flush();}
        catch(error){
            if(!ports.current()||!isAttemptRevisionConflict(error)
                ||!await driver.runtime.session.recoverCheckpointConflict())throw error;
            if(!ports.current())return;
            await ports.flush();
            if(ports.current())ports.error('');
        }
        if(!ports.current())return;
        await driver.source.review();if(!ports.current())return;
        ports.restore(driver.restore());await ports.refresh(driver);
    }catch(error){if(ports.current())ports.error(error instanceof Error?error.message:'核对暂不可用，原答案已保留。');}
    finally{ports.lock(false);if(ports.current())ports.busy(false);}
}
