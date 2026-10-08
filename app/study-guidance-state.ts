/** UI acknowledgements only. No answers, source paths or learning events are stored. */
export type GuidanceStorage = Pick<Storage, 'getItem' | 'setItem'>;
export type GuidanceSnapshot = 'unknown' | 'first' | 'seen';
export const GUIDANCE_VERSION = 1;
const PREFIX = 'zhixue:study-guidance:v1:';
export function guidanceKey(scope: string | undefined, topic: string): string {
  return PREFIX + encodeURIComponent(JSON.stringify([scope || null, topic]));
}
export function createGuidanceStore(getStorage: () => GuidanceStorage | undefined = () => undefined) {
  const values = new Map<string, GuidanceSnapshot>();
  const listeners = new Map<string, Set<() => void>>();
  function publish(key: string, value: GuidanceSnapshot) {
    if (values.get(key) === value) return;
    values.set(key, value);
    for (const listener of [...(listeners.get(key) ?? [])]) listener();
  }
  function load(scope: string | undefined, topic: string) {
    const key = guidanceKey(scope, topic);
    if (values.has(key)) return;
    let seen = false;
    // Unknown identities use memory only, never another user's saved settings.
    if (scope) { try { seen = getStorage()?.getItem(key) === '1'; } catch { /* Page-local fallback. */ } }
    publish(key, seen ? 'seen' : 'first');
  }
  return {
    snapshot(scope: string | undefined, topic: string): GuidanceSnapshot {
      return values.get(guidanceKey(scope, topic)) ?? 'unknown';
    },
    subscribe(scope: string | undefined, topic: string, listener: () => void) {
      const key = guidanceKey(scope, topic), bucket = listeners.get(key) ?? new Set<() => void>();
      listeners.set(key, bucket); bucket.add(listener); load(scope, topic);
      return () => { bucket.delete(listener); if (!bucket.size) listeners.delete(key); };
    },
    acknowledge(scope: string | undefined, topic: string) {
      const key = guidanceKey(scope, topic);
      if (values.get(key) === 'seen') return;
      publish(key, 'seen');
      if (scope) { try { getStorage()?.setItem(key, '1'); } catch { /* Keep this session quiet. */ } }
    },
    receiveStorage(key: string | null, value: string | null) {
      if (key?.startsWith(PREFIX) && value === '1') publish(key, 'seen');
    },
  };
}
export type GuidanceStore = ReturnType<typeof createGuidanceStore>;
