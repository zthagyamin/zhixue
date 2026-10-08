import {getChatGPTUser} from '../../chatgpt-auth';
import {getDb} from '../../../db';
import {D1ReviewEventStore} from '../../../db/review-event-store';
import {createSyncRouteHandlers} from '../../sync-v3-api';
import {createLegacySyncRequests,type LegacySyncResult} from '../../../src/application/sync';
import {createLegacySyncD1} from '../../../src/infrastructure/sync-server';
export const dynamic='force-dynamic';
const persistence=createLegacySyncD1(getDb),legacy=createLegacySyncRequests(persistence);
const respond=(result:LegacySyncResult)=>Response.json(result.value,{status:result.status});
const handlers=createSyncRouteHandlers({getUser:getChatGPTUser,createStore:async owner=>{await persistence.ensureAccount(owner);return new D1ReviewEventStore(getDb());},
 legacy:{getSnapshot:async(_request,user)=>respond(await legacy.snapshot(user.userId)),migrate:async(body,user)=>respond(await legacy.migrate(user.userId,body)),events:async(body,user)=>respond(await legacy.events(user.userId,body))},
});
export const GET=handlers.GET,POST=handlers.POST;
