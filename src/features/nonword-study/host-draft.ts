import type { HostDraft, HostDriver } from './host-contracts';
import {useMemo,useCallback} from 'react';
import type { HostGradeOptions } from './host-contracts';
import type { FSRSRating } from '../../domain/assessment';
import type { AttemptCheckpoint } from '../../domain/learning-attempt';
type Options = {
    raw: HostDraft;
    temporary: boolean;
    active: () => HostDriver | null;
    isPrimary: () => boolean;
    current: () => boolean;
    values: () => Record<string, unknown>;
    continue: (driver: HostDriver) => Promise<void>;
    scheduleSave: () => void;
};
/** Bind a plugin draft to primary or auxiliary work without giving it a storage port. */
export function createHostDraft(options: Options): HostDraft {
    return { ...options.raw,
        hasSavedFeedback: () => options.isPrimary() && (Boolean(options.raw.hasSavedFeedback?.())
            || options.active()?.runtime.session.snapshot()?.formal?.status === 'linked'),
        continueAfterFeedback() {
            const current = options.active();
            if (!current || !options.current())
                return false;
            if (options.temporary && !current.group)
                return Boolean(options.raw.continueAfterFeedback?.());
            if (!options.temporary && (current.runtime.purpose !== 'first' || current.runtime.session.snapshot()?.formal?.status !== 'linked'))
                return false;
            void options.continue(current);
            return true;
        },
        read<T>(field: string, initial: T): T {
            const values = options.values();
            if (Object.hasOwn(values, field))
                return values[field] as T;
            const value = options.isPrimary() ? options.raw.read(field, initial) : initial;
            values[field] = structuredClone(value);
            return value;
        },
        write(field, value) { options.values()[field] = structuredClone(value); const written = options.isPrimary() ? options.raw.write(field, value) : true; options.scheduleSave(); return written; },
    };
}

export function useHostDraft(options:Options,generation:number){
  // Constructor ports belong to the mounted binding and read its live scope.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(()=>createHostDraft(options),[options.raw,generation]);
}
/** A child waits for the current submit before switching its draft boundary. */
export function trackPluginGrade(grade: (rating: FSRSRating, options?: HostGradeOptions) => Promise<void>, task: {
    current: Promise<void> | null;
}) {
    return (rating: FSRSRating, options?: HostGradeOptions) => {
        const operation = grade(rating, options);
        task.current = operation;
        const clear = () => {
            if (task.current === operation)
                task.current = null;
        };
        void operation.then(clear, clear);
        return operation;
    };
}

export function useTrackedPluginGrade(grade:Parameters<typeof trackPluginGrade>[0],task:Parameters<typeof trackPluginGrade>[1]){
  return useCallback((rating:FSRSRating,options?:HostGradeOptions)=>trackPluginGrade(grade,task)(rating,options),[grade,task]);
}
/** Store only the closed recovery projection through the controlled session. */
export async function persistHostView(parent: HostDriver | null, view: NonNullable<AttemptCheckpoint['view']>) {
    if (!parent)
        return;
    await parent.runtime.session.updateView({ view: { purpose: view.purpose, lessonStep: view.lessonStep, paused: view.paused, referenceSeen: view.referenceSeen, ...(view.instanceId ? { instanceId: view.instanceId } : {}) } });
    await parent.runtime.afterWrite();
}

/** A late status reply may update only the driver still visible in this binding. */
export async function refreshHostStatus(driver: HostDriver, current: () => boolean, publish: (status: string) => void) {
    const status = await driver.runtime.status();
    if (current())
        publish(status);
}
