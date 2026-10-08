"""Native course diagnosis/claim sequencing through narrow, authenticated ports."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable


@dataclass(frozen=True)
class NativeCourseRules:
    parse_grade: Callable
    parse_claim: Callable
    resolve_support: Callable
    resolve_task: Callable
    task_hash: Callable
    choose_remediation: Callable
    validate_diagnostic: Callable
    parse_trace: Callable
    deterministic_diagnostic: Callable
    receipt: Callable
    unknown: Callable
    maximum_rating: Callable


@dataclass(frozen=True)
class NativeCoursePorts:
    rules: NativeCourseRules
    library_id: Callable
    read_source: Callable
    capture_source: Callable
    read_attempt: Callable
    begin: Callable
    reserve: Callable
    prepare: Callable
    finish: Callable
    read_claim: Callable
    read_claim_by_event: Callable
    save_claim: Callable
    settings: Callable
    provider: Callable


class NativeCourseApplication:
    def __init__(self, ports: NativeCoursePorts):
        self.ports = ports

    def read_attempt(self, attempt_id):
        return self.ports.read_attempt(attempt_id)

    def read_claim(self, attempt_id, event_id=None):
        return self.ports.read_claim(attempt_id, event_id)

    def read_claim_by_event(self, event_id):
        return self.ports.read_claim_by_event(event_id)

    def _library(self, request):
        if request['identity']['libraryId'] != self.ports.library_id():
            raise ValueError('native-course-library-changed')

    def _current(self, request):
        self._library(request)
        self.ports.capture_source(request['identity'], request['captureId'])
        self._library(request)

    def _task(self, request):
        capture = self.ports.read_source(request['identity'], request['captureId'])
        rules = self.ports.rules
        support = rules.resolve_support(capture['item'])
        selected = support['task']['taskId']
        if request['parentAttemptId'] is not None:
            parent = self.ports.read_attempt(request['parentAttemptId'])
            if parent is None or parent['state'] != 'resolved':
                raise ValueError('native-course-parent-unresolved')
            saved = parent['receipt']
            if (saved['diagnosticHash'] != request['parentDiagnosticHash']
                    or saved['binding'] != request['binding'] or saved['identity'] != request['identity']
                    or saved['captureId'] != request['captureId']):
                raise ValueError('native-course-parent-mismatch')
            choice = rules.choose_remediation(support, saved['diagnostic'])
            selected = choice['taskId'] if choice else selected
        task = rules.resolve_task(capture['item'], selected)
        if request['taskId'] != selected or request['taskHash'] != rules.task_hash(task):
            raise ValueError('native-course-task-mismatch')
        return support, task

    def _persist(self, request, diagnostic, trace, support=None, usage=None):
        remediation = self.ports.rules.choose_remediation(support, diagnostic) if support else None
        receipt = self.ports.rules.receipt(request, diagnostic, trace,
                                          remediation['taskId'] if remediation else None)
        # A validated provider result has its own committed recovery stage. The
        # public receipt is only released after finish commits the exact result.
        self.ports.prepare(request, receipt, usage)
        return self.ports.finish(request)

    def grade(self, payload):
        rules = self.ports.rules
        request = rules.parse_grade(payload)
        self._library(request)
        began = self.ports.begin(request)
        if began['kind'] == 'receipt':
            return began['receipt']
        if began['kind'] == 'prepared':
            return self.ports.finish(request)
        if began['kind'] == 'orphan':
            return self._persist(request, rules.unknown('unavailable', '此前评价回执未知；保留原答案等待核对。'), None)
        try:
            support, task = self._task(request)
            self._current(request)
        except (ValueError, OSError):
            return self._persist(request, rules.unknown('source-conflict'), None)
        answer = request['submission']['answer']
        if request['action'] == 'self-assess':
            diagnostic = {**rules.unknown('uncertain'), 'status': request['selfStatus'],
                          'source': 'self-assess', 'feedback': '学习者明确自评。'}
            diagnostic.pop('reason')
            return self._persist(request, diagnostic, None, support)
        if task['mode'] == 'quiz':
            try:
                diagnostic = rules.deterministic_diagnostic(task, answer)
            except ValueError:
                diagnostic = rules.unknown('invalid-result')
            return self._persist(request, diagnostic, None, support)
        try:
            settings = self.ports.settings()
            if not settings.get('enabled') or not settings.get('configured'):
                raise ValueError('ai-unconfigured')
            reservation = self.ports.reserve(request, task, settings)
            result = self.ports.provider(task, answer, request['requestId'], settings, reservation)
            diagnostic = rules.validate_diagnostic(result['diagnostic'], task, answer)
            trace = rules.parse_trace(result['trace'])
            if (diagnostic['source'] != 'model' or trace is None
                    or trace['requestId'] != request['requestId']
                    or trace['modelId'] != settings['model']
                    or trace.get('provider') != settings['provider']
                    or trace['promptVersion'] != 'course-task-json-v1'
                    or trace['ruleVersion'] != 'course-diagnostic-v1'):
                raise ValueError('invalid-course-provider-trace')
            usage = result.get('usageTokens')
            if usage is not None and (type(usage) is not int or usage < 0 or usage > reservation):
                raise ValueError('invalid-course-provider-usage')
        except (ValueError, OSError, TimeoutError, KeyError, TypeError):
            return self._persist(request, rules.unknown('unavailable'), None, support)
        try:
            self._current(request)
        except (ValueError, OSError):
            return self._persist(request, rules.unknown('source-conflict'), None, support, usage)
        return self._persist(request, diagnostic, trace, support, usage)

    def claim(self, payload):
        claim = self.ports.rules.parse_claim(payload)
        self._library(claim)
        saved_claim = self.ports.read_claim(claim['attemptId'])
        if saved_claim:
            if saved_claim['claim'] != claim:
                raise ValueError('native-course-claim-conflict')
            _, task = self._task(saved_claim['request'])
            self.ports.rules.validate_diagnostic(saved_claim['receipt']['diagnostic'], task,
                                                 saved_claim['request']['submission']['answer'])
            return saved_claim['claimReceipt']
        saved = self.ports.read_attempt(claim['attemptId'])
        if saved is None or saved['state'] != 'resolved':
            raise ValueError('native-course-claim-unresolved')
        request, receipt = saved['request'], saved['receipt']
        _, task = self._task(request)
        self.ports.rules.validate_diagnostic(receipt['diagnostic'], task, request['submission']['answer'])
        basis = saved['diagnosisRequest']
        if receipt['diagnostic']['source'] == 'self-assess' and (
                basis['action'] != 'self-assess' or basis['selfStatus'] != receipt['diagnostic']['status']):
            raise ValueError('native-course-claim-ineligible')
        if (request['purpose'] != 'first' or request['parentAttemptId'] is not None
                or any(receipt[key] != claim[key] for key in ('binding', 'identity', 'captureId',
                    'attemptId', 'diagnosticHash', 'attemptEvaluationHash'))
                or claim['occurredAt'] != request['submission']['submittedAt']):
            raise ValueError('native-course-claim-ineligible')
        ratings = ('again', 'hard', 'good', 'easy')
        # Unknown observation coverage remains unknown in the frozen submission.
        # A resolved performance grade does not establish independent mastery.
        maximum = self.ports.rules.maximum_rating(receipt['diagnostic']['status'])
        submission = request['submission']
        if submission.get('answerRevealed') or submission.get('maxPreHintLevel', 0) >= 3:
            maximum = 'again'
        elif submission.get('maxPreHintLevel', 0) >= 2:
            maximum = ratings[min(ratings.index(maximum), 1)]
        if ratings.index(claim['rating']) > ratings.index(maximum):
            raise ValueError('native-course-claim-rating-upgrade')
        self._current(request)
        return self.ports.save_claim(claim)
