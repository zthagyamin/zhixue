export type AccountRuleDraftPhase = 'checking' | 'generating' | 'saving';

/** Track only stages that actually execute; this path does not approve or request AI. */
export async function generateAccountRuleDraft<C, F, P>(ports: {
  onPhase: (phase: AccountRuleDraftPhase | null) => void;
  compose: () => Promise<C>;
  generate: (context: C) => Promise<F>;
  merge: (context: C, fresh: F) => Promise<P>;
  check: (context: C, plan: P) => Promise<void>;
  save: (context: C, plan: P) => Promise<void>;
}): Promise<P> {
  try {
    ports.onPhase('checking');
    const context = await ports.compose();
    ports.onPhase('generating');
    const fresh = await ports.generate(context);
    const plan = await ports.merge(context, fresh);
    await ports.check(context, plan);
    ports.onPhase('saving');
    await ports.save(context, plan);
    return plan;
  } finally {
    ports.onPhase(null);
  }
}
