export type TemporaryDraft = {
    readonly binding: string;
    read: (field: string) => string;
    values: () => Record<string, string>;
    write: (field: string, value: string) => boolean;
    acknowledge: () => void;
    hasUnsavedInput: () => boolean;
    isActive: () => boolean;
    isBusy: () => boolean;
    setBusy: (value: boolean) => void;
    dispose: () => void;
    subscribe: (listener: () => void) => () => void;
    getSnapshot: () => number;
};

/** Page-only input. Deliberately has no formal event, grade, scheduling or persistence port. */
export function createTemporaryDraft(options: {
    initial: Record<string, string>;
    binding?: string;
    isCurrent?: () => boolean;
    onChange?: () => void;
    onDispose?: () => void;
}): TemporaryDraft {
    let values = { ...options.initial }, baseline = { ...values };
    let disposed = false, busy = false, revision = 0;
    const listeners = new Set<() => void>();
    const active = () => !disposed && (options.isCurrent?.() ?? true);
    const notify = () => {
        revision++;
        options.onChange?.();
        for (const listener of [...listeners]) listener();
    };
    return {
        binding: options.binding ?? 'temporary',
        read: field => values[field] ?? '',
        values: () => ({ ...values }),
        write(field, value) {
            const limit = field === 'code' ? 100000 : field === 'stdin' ? 10000 : 12000;
            if (!active() || busy || !Object.hasOwn(values, field) || typeof value !== 'string' || value.length > limit) return false;
            if (values[field] === value) return true;
            values = { ...values, [field]: value }; notify(); return true;
        },
        acknowledge() { if (active()) { baseline = { ...values }; notify(); } },
        hasUnsavedInput: () => active() && (busy || Object.keys(values).some(field => values[field] !== baseline[field])),
        isActive: active,
        isBusy: () => busy && active(),
        setBusy(value) { if (active() && busy !== value) { busy = value; notify(); } },
        dispose() {
            if (disposed) return;
            disposed = true; busy = false; values = {}; baseline = {};
            options.onDispose?.(); notify(); listeners.clear();
        },
        subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener); }; },
        getSnapshot: () => revision,
    };
}
