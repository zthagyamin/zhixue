import {sharedAccountRead} from '../account-study-read';
import {readBoundStudyHistory} from '../native-bound-read';
export const readDashboardBoundHistory=(workspaceId:string,forceFull:boolean|undefined,signal:AbortSignal)=>
 sharedAccountRead(fetch,JSON.stringify(['native-bound-v1',workspaceId,Boolean(forceFull)]),signal=>readBoundStudyHistory({workspaceId,signal,isCurrent:()=>!signal.aborted,forceFull}),signal);
