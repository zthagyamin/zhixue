"""Evidence-bound original-code review contracts. Never execute learner code."""
from __future__ import annotations

import json
import re
from application.source_admission import canonical_json, parse_binding, parse_submission

RULE_VERSION = 'code-review-v1'
MAX_INPUT_BYTES = 64000
MAX_OUTPUT_BYTES = 100000


def bounded_review_json(value, maximum=MAX_INPUT_BYTES):
    try:
        encoded = canonical_json(value)
        if len(encoded.encode('utf-8')) > maximum:
            raise ValueError()
        return encoded
    except (ValueError, TypeError, UnicodeError, OverflowError, RecursionError):
        raise ValueError('code-review-data-limit') from None


def _text(value):
    return type(value) is str and bool(value.strip())


def prepare_code_review(attempt, *, parse_support):
    """Snapshot the authoritative source and immutable declaration input.

    Report validation is reused from the declaration protocol; it performs no
    code execution. Capture confirmation may change captureId, while reports
    must remain bound to the original submitted revision and binding.
    """
    from application.source_code_report import parse_request, validate_source

    try:
        submission = attempt['submission']
        binding = submission['binding']
        scope = (binding['ownerId'], binding['libraryId'])
        submission = parse_submission(submission, *scope)
        capture = attempt['capture']
        if capture['status'] != 'confirmed':
            raise ValueError('code-review-source-unconfirmed')
        capture_binding = parse_binding(capture['binding'], *scope)
        source_binding = parse_binding(capture['sourceBinding'], *scope)
        descriptor = capture['descriptor']
        expected_source = {**capture_binding, 'itemKey': descriptor['sourceKey'],
                           'contentHash': descriptor['sourceHash']}
        if (source_binding != expected_source or attempt.get('sourceBinding', source_binding) != source_binding
                or any(capture_binding[key] != binding[key] for key in
                       ('ownerId', 'libraryId', 'itemKey', 'contentHash'))):
            raise ValueError('code-review-source-binding')
        item = descriptor['item']
        if item.get('questionType') != 'code':
            raise ValueError('code-review-source-kind')
        code, prompt = submission['answer'], item.get('prompt')
        if not _text(code):
            raise ValueError('code-review-original-code-required')
        if not _text(prompt) or prompt == code:
            raise ValueError('code-review-task-required')
        references = [item[field] for field in ('referenceCode', 'solutionCode') if field in item]
        if any(not _text(reference) for reference in references) or len(set(references)) > 1:
            raise ValueError('code-review-reference-ambiguous')
        reference = references[0] if references else None
        support = item.get('learningSupport')
        cases = parse_support(support)['cases'] if support is not None else []
        if not reference and not cases:
            raise ValueError('code-review-reference-required')
        receipts = attempt.get('codeReports')
        if type(receipts) is not list or not receipts:
            raise ValueError('code-review-report-required')
        reports = []
        for receipt in receipts:
            request = parse_request(receipt['evidence'], scope)
            if any(request[key] != submission[key] for key in
                   ('attemptId', 'binding', 'answerRevision', 'submittedAt')):
                raise ValueError('code-review-report-binding')
            validate_source(request, capture, parse_support)
            report = request['report']
            if report['mapping']['originalLineCount'] != len(code.split('\n')):
                raise ValueError('code-review-report-mapping')
            reports.append(report)
        if reports[-1]['outcome'] not in ('success', 'student-error'):
            raise ValueError('code-review-report-unattributed')
        units = {'task': prompt}
        if reference:
            units['reference-code'] = reference
        units.update({'case:' + case['id']: canonical_json(case) for case in cases})
        data = {key: submission[key] for key in
                ('attemptId', 'answerRevision', 'answer', 'submittedAt', 'binding')}
        data.update(sourceBinding=source_binding, prompt=prompt, referenceCode=reference,
                    cases=cases, codeReports=receipts, referenceUnits=units)
        return json.loads(bounded_review_json(data))
    except (ValueError, KeyError, TypeError, AttributeError, UnicodeError, OverflowError, RecursionError) as error:
        reason = str(error)
        if not reason.startswith('code-review-'):
            reason = 'code-review-invalid-evidence'
        raise ValueError(reason) from None


def _pending(reason):
    return {'status': 'pending', 'reason': 'code-review-' + reason}


def _unsupported_claim(text):
    return bool(re.search(r'\b(?:master(?:ed|y)|self[- ]?assess(?:ment)?|full\s+coverage)\b|全面掌握|完全掌握|全覆盖|自评', text, re.I))


def normalize_code_review(raw, data):
    """Abstain unless a closed diagnostic quotes its exact source and answer."""
    try:
        bounded_review_json(raw, MAX_OUTPUT_BYTES)
        if type(raw) is not dict or set(raw) != {'outcome', 'explanation', 'checks'}:
            return _pending('invalid-output')
        outcome, explanation, checks = raw['outcome'], raw['explanation'], raw['checks']
        if (outcome not in ('correct', 'partial', 'incorrect', 'undetermined')
                or not _text(explanation) or len(explanation) > 8000
                or _unsupported_claim(explanation) or type(checks) is not list or len(checks) > 128):
            return _pending('invalid-output')
        if outcome == 'undetermined':
            return _pending('undetermined') if not checks else _pending('contradictory-output')
        units, code, checked, statuses = data['referenceUnits'], data['answer'], set(), []
        failing_case = data['codeReports'][-1]['evidence']['report'].get('firstFailure', {}).get('caseId')
        for check in checks:
            if type(check) is not dict or set(check) != {'referenceId', 'sourceQuote', 'codeQuote', 'status', 'explanation'}:
                return _pending('invalid-check')
            ident, source, quote = check['referenceId'], check['sourceQuote'], check['codeQuote']
            status, reason = check['status'], check['explanation']
            if (type(ident) is not str or ident not in units or not _text(source)
                    or source not in units[ident] or type(quote) is not str
                    or quote not in code or status not in ('matched', 'missing', 'incorrect')
                    or (not quote.strip() and status != 'missing') or not _text(reason)
                    or len(reason) > 4000 or _unsupported_claim(reason)):
                return _pending('unsupported-check')
            if failing_case and ident == 'case:' + failing_case and status == 'matched':
                return _pending('contradictory-report')
            checked.add(ident)
            statuses.append(status)
        if 'task' not in checked or not (checked - {'task'}):
            return _pending('reference-check-required')
        gaps = any(status != 'matched' for status in statuses)
        if outcome == 'correct':
            if gaps or checked != set(units):
                return _pending('incomplete-review')
            if any(row['evidence']['report']['outcome']=='student-error' for row in data['codeReports']):
                return _pending('contradictory-report')
        elif not gaps or outcome == 'partial' and 'matched' not in statuses:
            return _pending('contradictory-output')
        return {'status': 'resolved', 'correct': outcome == 'correct',
                'outcome': outcome, 'explanation': explanation}
    except (ValueError, KeyError, TypeError, AttributeError, UnicodeError, OverflowError, RecursionError):
        return _pending('invalid-output')
