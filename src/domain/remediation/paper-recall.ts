/** Presentation classification only; never changes item identity, score or scheduling. */
export function isPaperRecallSource(...sources:unknown[]):boolean {
    return sources.some(source=>{
        if(!source||typeof source!=='object'||Array.isArray(source))return false;
        const value=source as {domain?:unknown;sourceLabel?:unknown};
        return value.domain==='paper'||value.sourceLabel==='论文核心观点'||value.sourceLabel==='论文核心要点';
    });
}

