import {useState} from 'react';
/** Per-attempt visible/paused clock. The caller supplies time and active ownership. */
export function createActiveClock<T>(options: {
    current: () => T | null;
    initial: (value: T) => number;
    counting: () => boolean;
    now: () => number;
}) {
    const clocks = new Map<T, {
        seconds: number;
        last: number;
        counting: boolean;
    }>();
    const tick = (current = options.current()) => {
        if (!current)
            return 0;
        const now = options.now();
        let clock = clocks.get(current);
        if (!clock) {
            clock = { seconds: options.initial(current), last: now, counting: options.counting() };
            clocks.set(current, clock);
        }
        const delta = now - clock.last;
        clock.last = now;
        if (clock.counting)
            clock.seconds += Math.max(0, delta) / 1000;
        clock.counting = options.counting();
        return Math.min(86400, Math.floor(clock.seconds));
    };
    return { tick, has: (current: T) => clocks.has(current), deactivate(current: T) {
            const clock = clocks.get(current);
            if (clock)
                clock.counting = false;
        }, activate(current: T) { tick(current); const clock = clocks.get(current)!; clock.last = options.now(); clock.counting = options.counting(); } };
}

export function useHostClock<T>(options:Parameters<typeof createActiveClock<T>>[0]){
    const [clock]=useState(()=>createActiveClock(options));return clock;
}
