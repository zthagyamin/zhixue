/** Component-local initialization seam; never shares a driver between bindings. */
export function createHostInitialization<T>() {
    let current: { binding: string; promise: Promise<T> } | null = null;
    return { get(binding: string, create: () => Promise<T>) {
        if (current?.binding === binding)
            return current.promise;
        const entry: { binding: string; promise: Promise<T> } = {
            binding,
            promise: Promise.resolve().then(create).catch(error => {
                if (current === entry)
                    current = null;
                throw error;
            }),
        };
        current = entry;
        return entry.promise;
    } };
}
