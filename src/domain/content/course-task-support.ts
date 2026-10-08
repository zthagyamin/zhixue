/** Source-authored tasks. Parsing is structural, never proof of teaching quality. */
export const COURSE_TASK_KINDS = ['definition', 'steps', 'comparison', 'conditions', 'application'] as const;
export type CourseTaskKind = typeof COURSE_TASK_KINDS[number];
export type CourseSource = {
    sourceId: string;
    label: string;
    locator: string;
    excerpt: string;
    version: string;
};
export type CourseCriterion = {
    id: string;
    text: string;
    weight?: number;
    mandatory?: boolean;
    sourceIds: string[];
};
export type CourseRemediation = {
    taskId: string;
    kind: CourseTaskKind;
    prompt: string;
    scope: string;
    conditions: string[];
    criteria: CourseCriterion[];
    answer: string;
    targetPointIds: string[];
    wrongOptionIds: string[];
    missingOptionIds: string[];
};
export type CourseTask = {
    taskId: string;
    kind: CourseTaskKind;
    prompt: string;
    scope: string;
    conditions: string[];
    sources: CourseSource[];
    reviewStatus: 'candidate' | 'verified' | 'disputed';
    remediations: CourseRemediation[];
};
export type CourseRecallSupport = {
    schemaVersion: 2;
    type: 'recall';
    task: CourseTask;
    criteria: CourseCriterion[];
    hints?: [string, string, string];
};
export function courseObject(raw: unknown, required: string[], optional: string[] = []) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)
        || ![Object.prototype, null].includes(Object.getPrototypeOf(raw))
        || required.some(key => !Object.hasOwn(raw, key))
        || Object.keys(raw).some(key => ![...required, ...optional].includes(key)))
        throw Error('invalid-course-task-object');
    return raw as Record<string, unknown>;
}
export function courseText(raw: unknown, maximum: number): string {
    // eslint-disable-next-line no-control-regex -- source text rejects unsafe control characters.
    if (typeof raw !== 'string' || !raw.trim() || raw.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/u.test(raw))
        throw Error('invalid-course-task-text');
    return raw;
}
function id(raw: unknown): string {
    const value = courseText(raw, 64);
    if (/[^a-zA-Z0-9:_.-]/u.test(value)) throw Error('invalid-course-task-id');
    return value;
}
function list(raw: unknown, maximum: number, minimum = 0): unknown[] {
    if (!Array.isArray(raw) || raw.length < minimum || raw.length > maximum) throw Error('invalid-course-task-list');
    return Array.from(raw);
}
export function courseReferences(raw: unknown, known: ReadonlySet<string>, maximum: number, minimum = 1): string[] {
    const values = list(raw, maximum, minimum).map(id);
    if (new Set(values).size !== values.length || values.some(value => !known.has(value))) throw Error('invalid-course-task-reference');
    return values;
}
function conditions(raw: unknown): string[] {
    return list(raw, 16).map(value => courseText(value, 1500));
}
function kind(raw: unknown): CourseTaskKind {
    if (!COURSE_TASK_KINDS.includes(raw as CourseTaskKind)) throw Error('invalid-course-task-kind');
    return raw as CourseTaskKind;
}
function sources(raw: unknown): CourseSource[] {
    const ids = new Set<string>();
    return list(raw, 12, 1).map(entry => {
        const row = courseObject(entry, ['sourceId', 'label', 'locator', 'excerpt', 'version']);
        const sourceId = id(row.sourceId), locator = courseText(row.locator, 1000);
        if (ids.has(sourceId)) throw Error('duplicate-course-task-source');
        ids.add(sourceId);
        if (/^(?:[a-zA-Z]:[\\/]|[\\/]|file:)/iu.test(locator.trim())) throw Error('local-course-task-locator');
        if (typeof row.version !== 'string' || row.version.length !== 64 || /[^a-f0-9]/u.test(row.version)) throw Error('invalid-course-source-version');
        return { sourceId, locator, label: courseText(row.label, 300), excerpt: courseText(row.excerpt, 16000), version: row.version };
    });
}
export function parseCourseCriteria(raw: unknown, sourceIds: ReadonlySet<string>): CourseCriterion[] {
    const ids = new Set<string>();
    return list(raw, 24, 1).map(entry => {
        const row = courseObject(entry, ['id', 'text', 'sourceIds'], ['weight', 'mandatory']);
        const pointId = id(row.id);
        if (ids.has(pointId)) throw Error('duplicate-course-task-criterion');
        ids.add(pointId);
        if (row.weight !== undefined && (typeof row.weight !== 'number' || !Number.isInteger(row.weight) || row.weight < 1 || row.weight > 1000)) throw Error('invalid-course-task-weight');
        if (row.mandatory !== undefined && typeof row.mandatory !== 'boolean') throw Error('invalid-course-task-mandatory');
        return {
            id: pointId, text: courseText(row.text, 1500), sourceIds: courseReferences(row.sourceIds, sourceIds, 12),
            ...(row.weight === undefined ? {} : { weight: row.weight as number }),
            ...(row.mandatory === undefined ? {} : { mandatory: row.mandatory as boolean }),
        };
    });
}
export function parseCourseTask(raw: unknown, rawCriteria: unknown, optionIds: readonly string[] = []) {
    const row = courseObject(raw, ['taskId', 'kind', 'prompt', 'scope', 'conditions', 'sources', 'reviewStatus', 'remediations']);
    const taskId = id(row.taskId), taskSources = sources(row.sources), sourceIds = new Set(taskSources.map(source => source.sourceId));
    const criteria = parseCourseCriteria(rawCriteria, sourceIds), pointIds = new Set(criteria.map(point => point.id));
    if (typeof row.reviewStatus !== 'string' || !['candidate', 'verified', 'disputed'].includes(row.reviewStatus)) throw Error('invalid-course-task-review');
    const childIds = new Set([taskId]);
    const remediations = list(row.remediations, 12).map(entry => {
        const child = courseObject(entry, ['taskId', 'kind', 'prompt', 'scope', 'conditions', 'criteria', 'answer', 'targetPointIds', 'wrongOptionIds', 'missingOptionIds']);
        const childId = id(child.taskId);
        if (childIds.has(childId)) throw Error('duplicate-course-remediation');
        childIds.add(childId);
        const targetPointIds = courseReferences(child.targetPointIds, pointIds, 24, 0);
        const wrongOptionIds = courseReferences(child.wrongOptionIds, new Set(optionIds), 32, 0);
        const missingOptionIds = courseReferences(child.missingOptionIds, new Set(optionIds), 32, 0);
        if (!targetPointIds.length && !wrongOptionIds.length && !missingOptionIds.length) throw Error('empty-course-remediation-trigger');
        return {
            taskId: childId, kind: kind(child.kind), prompt: courseText(child.prompt, 4000), scope: courseText(child.scope, 1500),
            conditions: conditions(child.conditions), criteria: parseCourseCriteria(child.criteria, sourceIds), answer: courseText(child.answer, 8000),
            targetPointIds, wrongOptionIds, missingOptionIds,
        };
    });
    const task: CourseTask = {
        taskId, kind: kind(row.kind), prompt: courseText(row.prompt, 4000), scope: courseText(row.scope, 1500),
        conditions: conditions(row.conditions), sources: taskSources, reviewStatus: row.reviewStatus as CourseTask['reviewStatus'], remediations,
    };
    return { task, criteria };
}
export function parseCourseRecallSupport(raw: unknown): CourseRecallSupport {
    const row = courseObject(raw, ['schemaVersion', 'type', 'task', 'criteria'], ['hints']);
    if (row.schemaVersion !== 2 || row.type !== 'recall') throw Error('unsupported-course-recall-support');
    parseCourseTask(row.task, row.criteria);
    if (row.hints !== undefined) {
        if (!Array.isArray(row.hints) || row.hints.length !== 3) throw Error('invalid-recall-hints');
        row.hints.forEach(value => courseText(value, 2000));
    }
    return structuredClone(row) as CourseRecallSupport;
}
