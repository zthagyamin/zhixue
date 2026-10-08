'use client';
import {useEffect, useMemo, useSyncExternalStore} from 'react';
import {createGuidanceStore, type GuidanceStore} from './study-guidance-state';
import {guidanceKind, guidanceTip, STUDY_GUIDES, type GuidanceTopic} from './study-guidance-content';
import './study-guidance.css';

type GuidanceContext = {guidanceScope?: string; guidanceInOptions?: boolean; paperServices?: {owner: string}};
let clientStore: GuidanceStore | undefined;
function browserStore() {
  if (typeof window === 'undefined') return undefined;
  if (!clientStore) clientStore = createGuidanceStore(() => window.localStorage);
  return clientStore;
}
const serverSnapshot = () => 'unknown' as const;
/** Viewing help never acknowledges a tutorial. Only dismissing it or doing its action does. */
export function StudyGuidanceHelp({kind}: {kind?: string}) {
  const key = guidanceKind(kind); if (!key) return null;
  const guide = STUDY_GUIDES[key];
  return <details className="study-guidance-help"><summary>操作说明与快捷键</summary>
    <h3>{guide.title}</h3>{guide.details.map(line => <p key={line}>{line}</p>)}
    {guide.shortcuts && <p>{guide.shortcuts}</p>}
    <p className="study-meta">入门提示只在首次使用时显示，完整说明始终保留在这里。</p>
  </details>;
}
export function StudyGuidance({topic, context, engaged = false}: {topic: GuidanceTopic; context?: GuidanceContext; engaged?: boolean}) {
  const scope = context?.guidanceScope || context?.paperServices?.owner;
  const binding = useMemo(() => {
    const store = browserStore();
    return {
      subscribe(listener: () => void) {
        if (!store) return () => {};
        const unsubscribe = store.subscribe(scope, topic, listener);
        const update = (event: StorageEvent) => store.receiveStorage(event.key, event.newValue);
        window.addEventListener('storage', update);
        return () => { unsubscribe(); window.removeEventListener('storage', update); };
      },
      snapshot: () => store?.snapshot(scope, topic) ?? 'unknown',
      acknowledge: () => store?.acknowledge(scope, topic),
    };
  }, [scope, topic]);
  const seen = useSyncExternalStore(binding.subscribe, binding.snapshot, serverSnapshot);
  useEffect(() => { if (engaged) binding.acknowledge(); }, [engaged, binding]);
  const first = seen === 'first' && !engaged;
  if (!first && context?.guidanceInOptions) return null;
  return <div className="study-guidance">
    {first && <div className="study-first-use-tip" data-guidance-topic={topic}>
      <p>{guidanceTip(topic)}</p><button type="button" onClick={event => {
        // Dismissing the tip must not leave keyboard focus on a removed node.
        const root = event.currentTarget.closest('.study-word-card,[data-study-activity],.paper-workshop');
        const next = Array.from(root?.querySelectorAll<HTMLElement>(
          '[data-study-key="1"], input:not([type="hidden"]), textarea, button, summary'
        ) ?? []).find(node => !node.closest('.study-guidance') && !node.matches(':disabled') && node.getClientRects().length > 0);
        next?.focus({preventScroll: true}); binding.acknowledge();
      }}>知道了</button>
    </div>}
    {!context?.guidanceInOptions && <StudyGuidanceHelp kind={topic}/>}
  </div>;
}
