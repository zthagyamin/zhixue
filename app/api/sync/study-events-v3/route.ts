import {getChatGPTUser} from '../../../chatgpt-auth';
import {handleBoundStudyEventsV3Get} from '../../../sync-v3-api';
import {D1ReviewEventStore} from '../../../../db/review-event-store';
import {getDb} from '../../../../db';
export const dynamic='force-dynamic';
export const GET=(request:Request)=>handleBoundStudyEventsV3Get(request,getChatGPTUser,()=>new D1ReviewEventStore(getDb()));
