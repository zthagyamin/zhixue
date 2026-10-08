'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { NonWordLearningPort, NonWordOutcome } from '../../application/nonword-study';
import type { FSRSRating } from '../../domain/assessment';
import { requireCourseFeedback, hostFormalRating } from './host-course-boundary';
import type { HostDriver, HostProps, HostGradeOptions } from './host-contracts';
export type { HostDraft, HostDriver } from './host-contracts';
import { useHostClock } from './host-clock';
import { HostView } from './host-view';
import { useHostDraft, useTrackedPluginGrade, persistHostView, refreshHostStatus } from './host-draft';
import { createHostInitialization } from './host-initialization';
import {useHostExecution} from './host-execution';
import {recordNonWordAuxiliary} from '../../application/nonword-study';
import {useHostVariant,hostVariantSeed,restoreHostAuxiliary} from './host-variant';
export function NonWordStudyHost(props: HostProps) {
    const [driver, setDriver] = useState<HostDriver | null>(null), [error, setError] = useState(''), [status, setStatus] = useState('正在恢复作答…');
    const [busy, setBusy] = useState(false), [paused, setPaused] = useState(false), [intent, setIntent] = useState<'review' | 'learn'>('review');
    const [lessonStep, setLessonStep] = useState<'reading' | 'guided' | 'independent'>('independent');
    const values = useRef<Record<string, unknown>>({}), saveQueue = useRef<Promise<unknown>>(Promise.resolve()), timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const live = useRef(true), gradeLock = useRef(false), continuationLock = useRef(false), shownReference = useRef(false), activeDriver = useRef<HostDriver | null>(null);
    const binding = useRef(props.bindingKey), [readyKey, setReadyKey] = useState('');
    const firstDriver = useRef<HostDriver | null>(null), gradeTask = useRef<Promise<void> | null>(null);
    const initialization = useRef(createHostInitialization<HostDriver>());
    const [generation, setGeneration] = useState(0), [elapsed, setElapsed] = useState(0);
    const view = useRef({ purpose: 'first' as 'first' | 'guided' | 'remediation', lessonStep: 'independent' as 'reading' | 'guided' | 'independent', paused: false, referenceSeen: false, instanceId: undefined as string | undefined });
    const groupBase = useRef(0), clock = useHostClock<HostDriver>({ current: () => activeDriver.current, initial: current => current.runtime.session.snapshot()?.checkpoint.activeSeconds ?? 0, counting: () => !view.current.paused && typeof document !== 'undefined' && document.visibilityState === 'visible', now: () => Date.now() });
    const tick = clock.tick, activate = clock.activate;
    const persistView = async (patch: Partial<typeof view.current> = {}) => {
        view.current = { ...view.current, ...patch };
        shownReference.current = view.current.referenceSeen;
        await persistHostView(firstDriver.current, view.current);
    };
    const [retryContinue, setRetryContinue] = useState(false);
    const [retryGrade, setRetryGrade] = useState<{
        rating: FSRSRating;
        options?: HostGradeOptions;
    } | null>(null);
    const refreshStatus = (current: HostDriver) => refreshHostStatus(current, () => live.current && activeDriver.current === current, setStatus);
    const save = async (current = activeDriver.current) => {
        if (!current)
            return;
        const captured = structuredClone(values.current), inputRevision = props.draft.inputRevision?.();
        const operation = saveQueue.current.then(async() => {await current.runtime.practice?.flush?.();return current.runtime.session.save(current.answer(captured), current.fields(captured), current.phase());}).then(() => current.runtime.session.updateView({ activeSeconds: tick(current), targetMinutes: 12 })).then(() => {
            if ((current.runtime.purpose === 'first' || props.temporary && current === firstDriver.current) && inputRevision !== undefined)
                props.draft.markInputRecovered?.(inputRevision);
        }).then(() => current.runtime.afterWrite()).then(() => refreshStatus(current));
        saveQueue.current = operation.catch(reason => {
            if (live.current) {
                setError(reason instanceof Error ? reason.message : '输入尚未保存。');
                setStatus('保存失败，当前输入保留。');
            }
        });
        return operation;
    };
    const flush = async () => {
        if (timer.current) {
            clearTimeout(timer.current);
            timer.current = null;
        }
        await save();
        await saveQueue.current;
    };
    const variant=useHostVariant({props,activeDriver,firstDriver,live,binding,continuationLock,gradeTask,view,values,shownReference,groupBase,intent,flush,persistView,
        grade:(rating,options)=>grade(rating,options),clock:{deactivate:clock.deactivate,activate},state:{driver:setDriver,
            lesson:()=>setLessonStep('independent'),generation:()=>setGeneration(value=>value+1),status:refreshStatus,busy:setBusy,error:setError}});
    useEffect(() => {
        live.current = true;
        binding.current = props.bindingKey;
        activeDriver.current = null;
        firstDriver.current = null;
        let cancelled = false;
        void initialization.current.get(props.bindingKey, () => props.createDriver('first', 'review')).then(async (current) => {
            if (cancelled)
                return;
            firstDriver.current = current;
            const round = await current.group?.read();
            if (cancelled)
                return;
            if (round && props.restoreRound?.(round))
                return;
            const stored = current.runtime.session.snapshot()!, savedView = stored.checkpoint.view;
            view.current = savedView ? { ...savedView, instanceId: savedView.instanceId } : { purpose: 'first', lessonStep: 'independent', paused: false, referenceSeen: false, instanceId: undefined };
            shownReference.current = Boolean(savedView?.referenceSeen)&&hostVariantSeed(savedView?.instanceId)===null;
            const restoredIntent = stored.checkpoint.intent === 'lesson' ? 'learn' : 'review';
            const active = await restoreHostAuxiliary(current,savedView,restoredIntent,props.createDriver,variant);
            if (cancelled)
                return;
            activeDriver.current = active;
            values.current = active.restore();
            setDriver(active);
            setReadyKey(props.bindingKey);
            setIntent(restoredIntent);
            setLessonStep(savedView?.lessonStep ?? 'independent');
            setPaused(Boolean(savedView?.paused));
            groupBase.current = await active.runtime.groupSeconds?.() ?? 0;
            setElapsed(groupBase.current + tick(active));
            void refreshStatus(active);
        }).catch(reason => {
            if (!cancelled)
                setError(reason instanceof Error ? reason.message : '恢复失败，原答案没有删除。');
        });
        return () => {
            cancelled = true;
            live.current = false;
            if (timer.current)
                clearTimeout(timer.current);
            void save().catch(() => { });
        };
        // A new owner/content/group remounts this boundary; constructor callbacks are scope-pinned.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [props.bindingKey]);
    useEffect(() => {
        const timer = setInterval(() => { setElapsed(groupBase.current + tick()); void save().catch(() => { }); }, 10000);
        const visibility = () => {
            const current = activeDriver.current;
            if (current) {
                const initialized = clock.has(current);
                if (initialized)
                    tick(current);
                void save().catch(() => { });
            }
        };
        document.addEventListener('visibilitychange', visibility);
        return () => { clearInterval(timer); document.removeEventListener('visibilitychange', visibility); };
        // Scope owns the interval; storage operations are serialized.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [props.bindingKey]);
    useEffect(() => {
        if (!driver)
            return;
        return driver.runtime.subscribeStatus?.(() => { void refreshStatus(driver); });
        // Status notifications are pinned to the active runtime.
    }, [driver]);
    const continueFormal = async (parent: HostDriver) => {
        if (continuationLock.current || !live.current || binding.current !== props.bindingKey)
            return;
        continuationLock.current = true;
        setBusy(true);
        setRetryContinue(false);
        try {
            await flush();
            const attempt = parent.runtime.session.snapshot();
            if (!props.temporary) {
                if (attempt?.formal?.status !== 'linked')
                    throw Error('正式结果尚未可靠保存。');
                await parent.runtime.session.markTraversed();
                await parent.runtime.afterWrite();
            }
            else if (parent.group) {
                await parent.runtime.session.markAuxiliaryTraversed();
                await parent.runtime.afterWrite();
            }
            const rating = attempt?.formal?.rating ?? (attempt?.evaluation.status === 'resolved' ? attempt.evaluation.rating : null);
            if (!rating)
                throw Error('本次作答仍待核对，请从待核对入口继续。');
            await parent.continueGroup?.(rating);
            if (live.current && binding.current === props.bindingKey && !props.draft.continueAfterFeedback?.())
                props.resumeFormal(rating);
        }
        catch (reason) {
            continuationLock.current = false;
            setRetryContinue(true);
            setError(reason instanceof Error ? reason.message : '续学状态尚未保存，请再试一次。');
        }
        finally {
            if (live.current)
                setBusy(false);
        }
    };
    const draft = useHostDraft({ raw: props.draft, temporary: props.temporary === true, active: () => activeDriver.current,
        isPrimary: () => activeDriver.current?.runtime.purpose === 'first' || props.temporary === true && activeDriver.current === firstDriver.current,
        current: () => live.current && binding.current === props.bindingKey && !continuationLock.current, values: () => values.current, continue: continueFormal,
        scheduleSave: () => {
            setStatus('正在保存在本机…');
            if (timer.current)
                clearTimeout(timer.current);
            timer.current = setTimeout(() => { timer.current = null; void save().catch(() => { }); }, 250);
        }
    }, generation);
    const execution=useHostExecution({current:()=>activeDriver.current?.runtime??null,primary:()=>firstDriver.current?.runtime??null,
        createChild:async(parent,id)=>(await props.createDriver('remediation',intent,parent,id)).runtime},props.bindingKey);
    const lifecycle = useMemo<NonWordLearningPort>(() => ({
        attemptId: driver?.runtime.session.snapshot()?.attemptId,
        ready: Boolean(driver && readyKey === props.bindingKey), purpose: driver?.runtime.purpose ?? 'first', intent,
        get submitted() { return Boolean(activeDriver.current?.runtime.session.snapshot()?.submitted); },
        get course(){return activeDriver.current?.course;},
        get practice(){return activeDriver.current?.runtime.practice;},
        ...(props.mode==='code'?{prepareExecution:execution.prepare,recordExecutionReport:execution.recordExecutionReport}:{}),
        get submittedHintLevel() { return activeDriver.current?.runtime.session.snapshot()?.submitted?.maxPreHintLevel; },
        get answerRevealed() { return activeDriver.current?.runtime.session.snapshot()?.submitted?.answerRevealed; },
        async recordHint(policy) {
            const current = activeDriver.current;
            if (!current || !live.current || binding.current !== props.bindingKey)
                throw Error('作答来源已经切换。');
            if (policy.schemaVersion !== 1 || !Number.isInteger(policy.maxPreHintLevel) || policy.maxPreHintLevel < 0 || policy.maxPreHintLevel > 3)
                throw Error('提示记录无效。');
            await flush();
            await current.runtime.session.save(current.answer(values.current), { ...current.fields(values.current), hintLevel: String(policy.maxPreHintLevel), policyAttemptId: policy.attemptId }, current.phase());
            await current.runtime.afterWrite();
            await refreshStatus(current);
        },
        async submit(answer) {
            const current = activeDriver.current;
            if (!live.current || binding.current !== props.bindingKey)
                throw Error('来源或账号已切换，本次操作已停止。');
            if (!current)
                throw Error('作答尚未恢复，请稍候。');
            await flush(); await current.runtime.practice?.beforeSubmit?.();
            const policy = draft.read<{
                maxPreHintLevel: number;
            } | null>('recallAttempt', null);
            const level = (props.mode === 'recall' && shownReference.current ? 3 : policy?.maxPreHintLevel) as 0 | 1 | 2 | 3 | undefined;
            await current.runtime.session.submit(answer, shownReference.current ? 'observed' : 'unknown', { ...(level === undefined ? {} : { maxPreHintLevel: level }), answerRevealed: shownReference.current });
            await current.runtime.afterWrite();
            await refreshStatus(current);
        },
        async assess(outcome: NonWordOutcome) {
            const current = activeDriver.current;
            if (!live.current || binding.current !== props.bindingKey)
                throw Error('来源或账号已切换，本次操作已停止。');
            if (!current)
                throw Error('作答尚未恢复。');
            await current.runtime.session.assess(outcome);
            await current.runtime.afterWrite();
            await refreshStatus(current);
        },
        async waitForReview(reason) {
            const current = activeDriver.current;
            if (!live.current || binding.current !== props.bindingKey)
                throw Error('来源或账号已切换，本次操作已停止。');
            if (!current)
                throw Error('答案尚未可靠保存。');
            await current.runtime.session.pending(/参考|来源/.test(reason) ? 'no-reference' : /AI|连接|停止|超时/.test(reason) ? 'offline' : 'invalid', reason);
            await current.runtime.afterWrite();
            await refreshStatus(current);
        },
        async continuePending() {
            const current = activeDriver.current;
            if (!live.current || binding.current !== props.bindingKey)
                throw Error('来源或账号已切换，本次操作已停止。');
            if (!current)
                throw Error('答案尚未可靠保存。');
            await flush();
            await current.runtime.session.traversePending();
            await current.runtime.afterWrite();
            if (current.runtime.purpose === 'guided') {
                setStatus('引导答案已保存，等待核对；可以收起讲解进入独立尝试。');
                return;
            }
            await current.continueGroup?.('pending');
            props.continuePending();
        },
        async recordRemediation(answer, outcome) {
            if(props.mode==='code')return execution.recordRemediation(answer,outcome);
            await recordNonWordAuxiliary({parent:firstDriver.current?.runtime??null,mode:props.mode,newId:()=>crypto.randomUUID(),
                createChild:async(parent,id)=>(await props.createDriver('remediation',intent,parent,id)).runtime},answer,outcome);
        },
        async startRemediation() {
            if (gradeTask.current)
                await gradeTask.current;
            const parent = firstDriver.current, attempt = parent?.runtime.session.snapshot();
            if (!parent || !attempt?.submitted)
                throw Error('请先可靠保存首轮答案。');
            if (!props.temporary && attempt.evaluation.status === 'resolved' && attempt.formal?.status !== 'linked')
                await grade(attempt.evaluation.rating, { deferAdvance: true });
            const copy = structuredClone(values.current);
            await switchDriver('remediation', intent,parent?.course?.remediationTaskId()??undefined);
            values.current = activeDriver.current?.course?activeDriver.current.restore():props.mode === 'code' ? { code: copy.code ?? attempt.submitted.answer, codeState: 'coding' } : props.mode === 'calculation' ? { value: copy.value ?? attempt.submitted.answer } : props.mode === 'recall' ? { answer: '', revealed: false } : {};
            setGeneration(value => value + 1);
        },
        startVariant:variant.start,
        async finishRemediation() {
            const parent = firstDriver.current;
            if (!parent?.runtime.session.snapshot()?.submitted)
                throw Error('首轮答案尚未保存。');
            if (continuationLock.current)
                return;
            const attempt = parent.runtime.session.snapshot()!;
            if (attempt.formal?.status === 'linked' || props.temporary && attempt.evaluation.status === 'resolved') {
                await continueFormal(parent);
                return;
            }
            continuationLock.current = true;
            setBusy(true);
            try {
                await flush();
                if (!live.current || binding.current !== props.bindingKey)
                    return;
                if (attempt.evaluation.status === 'pending') {
                    await parent.runtime.session.traversePending();
                    await parent.runtime.afterWrite();
                    await parent.continueGroup?.('pending');
                    if (live.current && binding.current === props.bindingKey)
                        props.continuePending();
                    return;
                }
                continuationLock.current = false;
                await switchDriver('first', intent);
                await grade(attempt.evaluation.rating);
            }
            catch (reason) {
                continuationLock.current = false;
                throw reason;
            }
            finally {
                if (live.current)
                    setBusy(false);
            }
        },
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }), [driver, draft, intent, generation, readyKey, props.bindingKey]);
    const grade = async (rating: FSRSRating, options?: HostGradeOptions) => {
        const current = activeDriver.current;
        if (!live.current || binding.current !== props.bindingKey)
            throw Error('来源或账号已切换，本次操作已停止。');
        if (!current || gradeLock.current)
            return;
        gradeLock.current = true;
        setBusy(true);
        setError('');
        try {
            await flush();
            let attempt = current.runtime.session.snapshot();
            if (!attempt?.submitted)
                await lifecycle.submit(current.answer(values.current));
            attempt = current.runtime.session.snapshot();
            await requireCourseFeedback(current);
            if (attempt?.evaluation.status !== 'resolved' && !['recall', 'flashcard'].includes(props.mode))
                throw Error('本题还没有可靠核对结果，不能生成成绩。');
            if (attempt?.evaluation.status !== 'resolved')
                await lifecycle.assess({ status: rating === 'good' || rating === 'easy' ? 'correct' : rating === 'hard' ? 'partial' : 'incorrect', source: props.mode === 'recall' || props.mode === 'flashcard' ? 'self-assess' : 'deterministic', rating, explanation: '用户明确提交的本次结果。' });
            attempt = current.runtime.session.snapshot();
            if (current.runtime.purpose !== 'first') {
                setStatus('辅助尝试已保存，首轮结果保持不变。');
                if (props.temporary && firstDriver.current === current) {
                    await props.onGrade(rating, { deferAdvance: true });
                    if (!options?.deferAdvance) {
                        if (current.group)
                            await continueFormal(current);
                        else if (!props.draft.continueAfterFeedback?.())
                            props.resumeFormal(rating);
                    }
                }
                return;
            }
            if (attempt?.formal?.status === 'linked') {
                if (!options?.deferAdvance)
                    await continueFormal(current);
                return;
            }
            const frozenPolicyLevel = attempt?.submitted?.maxPreHintLevel;
            const policy = draft.read<{
                schemaVersion: 1;
                attemptId: string;
                maxPreHintLevel: number;
            } | null>('recallAttempt', null);
            if (props.mode === 'recall' && policy && frozenPolicyLevel !== undefined) {
                const frozen = { ...policy, maxPreHintLevel: frozenPolicyLevel };
                values.current.recallAttempt = frozen;
                props.draft.write('recallAttempt', frozen);
            }
            const applied = hostFormalRating(props, current, draft, rating);
            const identity = await current.runtime.session.reserve(applied);
            await current.group?.synchronize();
            if (await current.group?.status() === 'cloud-conflict')
                throw Error('本组续学信息存在冲突，原答保留，尚未重复评分。');
            await (current.course?.beforeFormal?.()??current.runtime.synchronize?.());
            const restoredCore = await current.verifiedCore();
            if (restoredCore) {
                await current.runtime.session.link(restoredCore);
                await current.runtime.afterWrite();
                if (!options?.deferAdvance)
                    await continueFormal(current);
                return;
            }
            const result = await props.onGrade(applied, { deferAdvance: true, identity, continuationReceipt: true });
            if (result && typeof result === 'object' && 'status' in result && !['saved', 'continued'].includes(String(result.status)))
                throw Error('正式作答尚未保存成功，请重试保存。');
            const coreHash = await current.verifiedCore();
            if (!coreHash)
                throw Error('等待正式作答的持久回执，原答案和身份已保留。');
            await current.runtime.session.link(coreHash);
            if (!options?.deferAdvance)
                await current.runtime.session.markTraversed();
            await current.runtime.afterWrite();
            if (live.current && binding.current === props.bindingKey && !options?.deferAdvance) {
                await current.continueGroup?.(applied);
                if (!props.draft.continueAfterFeedback?.())
                    props.resumeFormal(applied);
            }
        }
        catch (reason) {
            setRetryGrade({ rating, options });
            if (live.current)
                setError(reason instanceof Error ? reason.message : '作答保存未完成。');
            throw reason;
        }
        finally {
            gradeLock.current = false;
            if (live.current)
                setBusy(false);
        }
    };
    const switchDriver = async (purpose: 'first' | 'guided' | 'remediation', nextIntent: 'review' | 'learn',taskId?:string) => {
        if (!live.current || binding.current !== props.bindingKey)
            throw Error('来源或账号已切换。');
        await flush();
        setBusy(true);
        try {
            const parent = firstDriver.current?.runtime.session.snapshot(), instanceId = purpose === 'first' ? undefined : crypto.randomUUID();
            const current = purpose === 'first' && firstDriver.current ? firstDriver.current : await props.createDriver(purpose, nextIntent, purpose !== 'first' && parent?.submitted ? parent.attemptId : undefined, instanceId,taskId);
            await persistView({ purpose, instanceId });
            const old = activeDriver.current;
            if (old)
                clock.deactivate(old);
            activeDriver.current = current;
            activate(current);
            if (purpose === 'first')
                firstDriver.current = current;
            values.current = current.restore();
            setDriver(current);
            groupBase.current = await current.runtime.groupSeconds?.() ?? 0;
            setGeneration(value => value + 1);
            await refreshStatus(current);
        }
        finally {
            setBusy(false);
        }
    };
    const chooseIntent = async (next: 'review' | 'learn') => {
        await switchDriver('first', next);
        await firstDriver.current!.runtime.session.updateView({ intent: next === 'learn' ? 'lesson' : 'practice' });
        await persistView({ lessonStep: next === 'learn' ? 'reading' : 'independent', referenceSeen: view.current.referenceSeen || next === 'learn' });
        setIntent(next);
        setLessonStep(next === 'learn' ? 'reading' : 'independent');
    };
    const pluginGrade = useTrackedPluginGrade(grade, gradeTask);
    return <HostView ready={Boolean(driver && readyKey === props.bindingKey)} busy={busy} paused={paused} intent={intent} lessonStep={lessonStep} purpose={driver?.runtime.purpose ?? 'first'} submitted={Boolean(driver?.runtime.session.snapshot()?.submitted)} temporary={props.temporary} status={status} elapsed={elapsed} error={error} retryContinue={retryContinue} retryGrade={Boolean(retryGrade)} generation={generation} question={driver?.course?.task.prompt??props.question} reference={driver?.course?.task.answer??props.reference} renderMath={props.renderMath} renderPlugin={props.renderPlugin} draft={draft} lifecycle={lifecycle} onGrade={pluginGrade} actions={{ chooseIntent: next => void chooseIntent(next).catch(reason => setError(String(reason))), pause: () => void flush().then(async () => { await persistView({ paused: !view.current.paused }); tick(); setPaused(view.current.paused); }).catch(reason => setError(String(reason))),
            retryContinue: () => {
                const parent = firstDriver.current;
                if (parent)
                    void continueFormal(parent);
            }, retryGrade: () => {
                const pending = retryGrade;
                if (pending)
                    void grade(pending.rating, pending.options).catch(() => { });
            },
            beginGuided: () => void switchDriver('guided', 'learn').then(() => persistView({ lessonStep: 'guided', referenceSeen: true })).then(() => setLessonStep('guided')).catch(reason => setError(String(reason))),
            skipRemediation: () => void lifecycle.finishRemediation?.().catch(reason => setError(String(reason))), beginIndependent: () => void switchDriver('first', 'learn').then(() => persistView({ lessonStep: 'independent' })).then(() => setLessonStep('independent')).catch(reason => setError(String(reason))) }}/>;
}
