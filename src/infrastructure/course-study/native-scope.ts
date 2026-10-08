import type {NonWordHostScope} from '../../application/nonword-study';
import type {NativeCourseItem} from '../../domain/course-study';
// @ts-expect-error TS5097: standalone Node contracts.
import {parseNativeCourseIdentity, resolveCourseTask} from '../../domain/course-study/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {isNonWordOriginal} from '../../domain/content/index.ts';
// @ts-expect-error TS5097: standalone Node contracts.
import {parseNativeMathIdentity,parseNativeMathItem} from '../../domain/math-study/index.ts';

/** Current display metadata can permit an ungraded draft; it is not a source receipt. */
export function nativeScopeReference(scope: NonWordHostScope, raw: unknown): Pick<NonWordHostScope, 'nativeCourseIdentity' | 'nativeCoursePresentation' | 'nativeMathIdentity' | 'nativeMathPresentation'> {
    if (scope.cloud || !raw || typeof raw !== 'object') return {};
    const data = raw as Record<string, unknown>, support = data.learningSupport as {schemaVersion?: unknown; type?: unknown} | undefined;
    if(data.questionType==='calculation'||data.pluginType==='calculation'||data.type==='calculation'||support?.type==='calculation'){
        // Legacy/local draft scopes do not assert a paired Native source identity.
        if(scope.snapshotId!=='local'||!/^local-vault:[a-f0-9]{64}$/.test(scope.libraryId))return {};
        if(!isNonWordOriginal('calculation',data)||typeof data.localBindingHash!=='string')return {};
        const identity=parseNativeMathIdentity({schemaVersion:1,libraryId:scope.libraryId,itemKey:scope.itemKey,contentHash:scope.contentHash,localBindingHash:data.localBindingHash});
        try{
            const item=parseNativeMathItem({schemaVersion:2,kind:'practice',eventKind:'due',itemKey:identity.itemKey,contentHash:identity.contentHash,
                ...(support?{learningSupport:data.learningSupport}:{}),practice:{questionType:'calculation',prompt:data.prompt,answer:data.answer,
                    sourceLabel:data.sourceLabel??'来源数学题',domain:data.domain??'math',...(data.explanation?{explanation:data.explanation}:{})}},identity);
            return {nativeMathIdentity:identity,nativeMathPresentation:item};
        }catch{return {nativeMathIdentity:identity};}
    }
    if (support?.schemaVersion !== 2 || !['recall', 'quiz'].includes(String(support.type))
        || !isNonWordOriginal(String(support.type), data) || typeof data.localBindingHash !== 'string') return {};
    const identity = parseNativeCourseIdentity({schemaVersion: 1, libraryId: scope.libraryId, itemKey: scope.itemKey,
        contentHash: scope.contentHash, localBindingHash: data.localBindingHash});
    const presentation = {schemaVersion: 2, kind: 'practice', eventKind: 'due', itemKey: identity.itemKey,
        contentHash: identity.contentHash, learningSupport: data.learningSupport,
        practice: {questionType: support.type, prompt: data.prompt, domain: data.domain}} as NativeCourseItem;
    if (typeof data.prompt !== 'string' || typeof data.domain !== 'string' || !data.domain.trim()) return {nativeCourseIdentity: identity};
    try {resolveCourseTask(presentation);} catch {return {nativeCourseIdentity: identity};}
    return {nativeCourseIdentity: identity, nativeCoursePresentation: presentation};
}
