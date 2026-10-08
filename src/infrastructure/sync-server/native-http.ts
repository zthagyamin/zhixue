import type {StudyEventV3} from '../../domain/evidence';
import type {SyncV3Store,ProcessStudyBatch} from '../../application/sync';
// @ts-expect-error TS5097: standalone Node contracts.
import {parseCloudStudyEventV3} from '../../domain/evidence/index.ts';
export type SyncIdentity={userId:string};
export type GetUser = () => Promise<SyncIdentity | null>;

export type CreateV3Store = (userId: string) => SyncV3Store | Promise<SyncV3Store>;

export type LegacySyncHandlers = {
  getSnapshot: (request: Request, user: SyncIdentity) => Promise<Response>;
  migrate: (body: Record<string, unknown>, user: SyncIdentity) => Promise<Response>;
  events: (body: Record<string, unknown>, user: SyncIdentity) => Promise<Response>;
};
function unauthorizedLegacyResponse(): Response {
  return Response.json({ message: "请先登录后再使用云同步。" }, { status: 401 });
}

function parseNonNegativeInteger(value: string | null, fallback: number): number | undefined {
  if (value === null) return fallback;
  if (!/^(?:0|[1-9]\d*)$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

export async function handleStudyEventsV3Post(
  body: Record<string, unknown>,
  getUser: GetUser,
  createStore: CreateV3Store,
  processStudyEventBatch:ProcessStudyBatch,
): Promise<Response> {
  const user = await getUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  if (!Array.isArray(body.events) || body.events.length > 50) {
    return Response.json({ error: "event-batch-too-large" }, { status: 400 });
  }

  let events: StudyEventV3[];
  try {
    events = await Promise.all(body.events.map(parseCloudStudyEventV3));
  } catch (error) {
    return Response.json(
      { error: error instanceof Error ? error.message : "invalid-study-event-v3" },
      { status: 400 },
    );
  }

  try {
    const result = await processStudyEventBatch(user.userId, events, await createStore(user.userId));
    return Response.json(result, { status: result.conflicts.length > 0 ? 409 : 200 });
  } catch (error) {
    // A concurrent replay produced a projection for the same event count with a
    // different event set. The events themselves are already accepted; the
    // caller must refetch the canonical projection through the v3 GET cursor.
    if (error instanceof Error && error.message === "projection-event-set-conflict") {
      return Response.json({ error: "projection-event-set-conflict" }, { status: 409 });
    }
    throw error;
  }
}

export async function handleStudyEventsV3Get(
  request: Request,
  getUser: GetUser,
  createStore: CreateV3Store,
): Promise<Response> {
  const user = await getUser();
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

  const { searchParams } = new URL(request.url);
  const after = parseNonNegativeInteger(searchParams.get("after"), 0);
  const requestedLimit = parseNonNegativeInteger(searchParams.get("limit"), 100);
  if (after === undefined || requestedLimit === undefined) {
    return Response.json({ error: "invalid-cursor" }, { status: 400 });
  }
  const limit = Math.min(Math.max(requestedLimit, 1), 100);

  const store = await createStore(user.userId);
  const events = await store.listEventsAfter(user.userId, after, limit);
  const itemMap = new Map<string, { itemKind: string; itemKey: string }>();
  for (const { event } of events) {
    itemMap.set(`${event.item.kind}\u0000${event.item.key}`, {
      itemKind: event.item.kind,
      itemKey: event.item.key,
    });
  }
  const projections = await store.listProjections(user.userId, [...itemMap.values()]);
  const cursor = events.at(-1)?.sequence ?? Math.min(after, await store.latestCursor(user.userId));

  return Response.json({ supported: true, cursor, events, projections });
}

/** New path only: old deployments cannot silently satisfy this protocol. */
export async function handleBoundStudyEventsV3Get(request:Request,getUser:GetUser,createStore:CreateV3Store):Promise<Response>{
  const headers={'Cache-Control':'no-store'},user=await getUser();
  if(!user)return Response.json({error:'unauthorized'},{status:401,headers});
  const params=new URL(request.url).searchParams;
  if(params.get('expectedUserId')!==user.userId)return Response.json({error:'study-owner-changed'},{status:409,headers});
  const after=parseNonNegativeInteger(params.get('after'),0),requested=parseNonNegativeInteger(params.get('limit'),20),fence=params.has('through')?parseNonNegativeInteger(params.get('through'),0):null;
  if(after===undefined||requested===undefined||fence===undefined)return Response.json({error:'invalid-cursor'},{status:400,headers});
  const store=await createStore(user.userId),latest=await store.latestCursor(user.userId),through=fence??latest;
  if(after>through||through>latest)return Response.json({error:'invalid-read-fence'},{status:400,headers});
  const events=await store.listEventsAfter(user.userId,after,Math.min(Math.max(requested,1),20),through),nextCursor=events.at(-1)?.sequence??after;
  return Response.json({protocol:'zhixue-native-history-v1',userId:user.userId,through,nextCursor,hasMore:nextCursor<through,events},{headers});
}

/**
 * Builds the executable /api/sync route boundary with injectable authentication,
 * v3 store creation, and legacy handlers. The real route delegates to this
 * factory with production dependencies; tests inject fakes to verify identity
 * derivation, v3/legacy dispatch, and the auth-before-body-parse invariant.
 */
export function createSyncRouteHandlers(deps: {
  getUser: GetUser;
  createStore: CreateV3Store;
  legacy: LegacySyncHandlers;
  processBatch:ProcessStudyBatch;
}) {
  async function GET(request: Request): Promise<Response> {
    const { searchParams } = new URL(request.url);
    if (searchParams.get("diagnostics") === "1") {
      const user = await deps.getUser();
      if (!user) return unauthorizedLegacyResponse();
      const store = await deps.createStore(user.userId);
      return Response.json(await store.diagnostics(user.userId));
    }
    if (searchParams.get("schemaVersion") === "3") {
      return handleStudyEventsV3Get(request, deps.getUser, deps.createStore);
    }
    const user = await deps.getUser();
    if (!user) return unauthorizedLegacyResponse();
    return deps.legacy.getSnapshot(request, user);
  }

  async function POST(request: Request): Promise<Response> {
    // Authentication happens before body parsing so unauthenticated malformed or
    // oversized requests keep the established 401 semantics for every action.
    const user = await deps.getUser();
    if (!user) return unauthorizedLegacyResponse();

    let body: Record<string, unknown>;
    try {
      const contentLength = request.headers.get("content-length");
      if (contentLength && parseInt(contentLength, 10) > 256000) {
        return Response.json({ error: "Payload too large" }, { status: 413 });
      }
      const rawBody = await request.text();
      if (rawBody.length > 64_000) return Response.json({ message: "同步请求过大。" }, { status: 413 });
      body = JSON.parse(rawBody) as Record<string, unknown>;
      if(!body||typeof body!=='object'||Array.isArray(body))throw new Error('invalid-sync-body');
    } catch {
      return Response.json({ message: "请求内容无效。" }, { status: 400 });
    }

    // Additive fail-closed action for new clients. An old server rejects this
    // name instead of silently ignoring an expected-owner field on a write.
    if(body.action==='study-events-v3-bound'){
      if(request.headers.get('Origin')!==new URL(request.url).origin)return Response.json({error:'origin-mismatch'},{status:403});
      if(typeof body.expectedUserId!=='string'||!body.expectedUserId||body.expectedUserId.length>256||Object.keys(body).some(key=>!['action','expectedUserId','events'].includes(key)))return Response.json({error:'invalid-owned-sync-request'},{status:400});
      if(body.expectedUserId!==user.userId)return Response.json({error:'account-mismatch'},{status:403});
      const response=await handleStudyEventsV3Post(body,async()=>user,deps.createStore,deps.processBatch);response.headers.set('Cache-Control','no-store');return response;
    }
    if (body.action === "study-events-v3") {
      return handleStudyEventsV3Post(body, deps.getUser, deps.createStore,deps.processBatch);
    }
    if (body.action === "migrate") return deps.legacy.migrate(body, user);
    if (body.action === "events") return deps.legacy.events(body, user);
    return Response.json({ message: "不支持的同步操作。" }, { status: 400 });
  }

  return { GET, POST };
}

export type SyncHttpDependencies=Parameters<typeof createSyncRouteHandlers>[0];
