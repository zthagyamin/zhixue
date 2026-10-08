"""Read-only preflight for the existing six-call QA batch. Never invokes a model."""
import hashlib
import json
import sqlite3
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
import argparse

PLAN_HASH = '53462b2cf6841ed4c076f6f28f74560430f29cf36cb2560f91d768af814b9522'
TASK_HASH = '45703108cbad21b12fbc66d50d691cf490b665dc1edf0240ad0279e162a29466'
SUMMARY_HASH = '947eb17b2d99585d6b4fbf77f1ef228576da69c3d98581fa75b40dbabacc3df8'


def read_json(path):
    raw = Path(path).read_bytes()
    return json.loads(raw), hashlib.sha256(raw).hexdigest()


def preflight(plan_path, task_path, summary_path, counter_path, ledger_path, *, now=None,
              expected_plan_hash=PLAN_HASH, expected_task_hash=TASK_HASH, expected_summary_hash=SUMMARY_HASH):
    plan, plan_hash = read_json(plan_path)
    tasks, task_hash = read_json(task_path)
    summary, summary_hash = read_json(summary_path)
    counter, _ = read_json(counter_path)
    limit, used = plan.get('maximumOutboundAttempts'), counter.get('attempts')
    if type(limit) is not int or limit != 6 or type(used) is not int or not 0 <= used <= limit:
        raise ValueError('resume-preflight-call-boundary')
    if (summary_hash != expected_summary_hash or plan_hash != expected_plan_hash or task_hash != expected_task_hash
            or summary.get('planHash') != plan_hash or summary.get('taskFileHash') != task_hash
            or summary.get('sourceVersion') != tasks.get('sourceVersion')
            or tasks.get('sourceVersion') != plan.get('sourceVersion')
            or summary.get('outboundAttempts') != used
            or summary.get('provider') != plan.get('frozenProvider')
            or summary.get('modelId') != plan.get('frozenModelId')
            or summary.get('promptVersion') != plan.get('promptVersion')
            or summary.get('ruleVersion') != plan.get('ruleVersion')):
        raise ValueError('resume-preflight-frozen-evidence-changed')
    cases = plan['cases']
    ids = [case['id'] for case in cases]
    if len(ids) != len(set(ids)) or len(ids) != limit:
        raise ValueError('resume-preflight-case-boundary')
    observations = summary['cases']
    sent = [row for row in observations if row.get('outboundAttempt') is not None]
    sent_ids = [row['caseId'] for row in sent]
    attempts = [row['outboundAttempt'] for row in sent]
    if (len(sent_ids) != len(set(sent_ids)) or not set(sent_ids).issubset(ids)
            or any(type(value) is not int for value in attempts)
            or sorted(attempts) != list(range(1, used + 1))):
        raise ValueError('resume-preflight-outbound-outcome-unknown')
    estimates = {row['caseId']: row['reservationTokens'] for row in summary['planReservations']}
    if set(estimates) != set(ids) or any(type(value) is not int or value < 1 for value in estimates.values()):
        raise ValueError('resume-preflight-reservation-boundary')
    day = (now or datetime.now(timezone.utc)).astimezone(timezone.utc).date().isoformat()
    uri = Path(ledger_path).resolve().as_uri() + '?mode=ro'
    with closing(sqlite3.connect(uri, uri=True)) as db:
        owners = db.execute('SELECT DISTINCT owner FROM native_course_requests WHERE reserved>0').fetchall()
        if len(owners) != 1:
            raise ValueError('resume-preflight-owner-boundary')
        owner = owners[0][0]
        all_reserved = db.execute('SELECT count(*) FROM native_course_requests WHERE owner=? AND reserved>0', (owner,)).fetchone()[0]
        if all_reserved != used:
            raise ValueError('resume-preflight-unreconciled-reservation')
        paid = {request_id: (tokens, budget_day) for request_id, tokens, budget_day in db.execute(
            'SELECT request_id,reserved,budget_day FROM native_course_requests WHERE owner=? AND reserved>0', (owner,)).fetchall()}
        original_day = datetime.fromisoformat(summary['startedAt']).astimezone(timezone.utc).date().isoformat()
        expected_paid = {'model-check-' + case_id: (estimates[case_id], original_day) for case_id in sent_ids}
        if paid != expected_paid:
            raise ValueError('resume-preflight-ledger-identity')
        count, reserved = db.execute('SELECT count(*),COALESCE(sum(reserved),0) FROM native_course_requests WHERE owner=? AND budget_day=? AND reserved>0', (owner, day)).fetchone()
    token_limit, request_limit = summary['dailyTokenLimit'], summary['dailyRequestLimit']
    if (type(token_limit) is not int or token_limit != 20000
            or type(request_limit) is not int or request_limit != 10
            or summary.get('maxOutputTokens') != plan.get('maxOutputTokens')):
        raise ValueError('resume-preflight-budget-boundary')
    remaining = [{'caseId': case['id'], 'reservationTokens': estimates[case['id']]} for case in cases if case['id'] not in sent_ids]
    allowed = bool(remaining and used < limit and count < request_limit
                   and reserved + remaining[0]['reservationTokens'] <= token_limit)
    status = 'outbound-cases-accounted' if not remaining else 'ready-for-profile-check' if allowed else 'waiting-budget'
    return {'schemaVersion': 1, 'status': status,
            'budgetDay': day, 'outboundAttempts': used, 'remainingAuthorization': limit - used,
            'completedOutboundCases': sent_ids, 'remainingCases': remaining,
            'reservedTokensToday': reserved, 'remainingReservationTokens': max(0, token_limit - reserved),
            'modelInvoked': False, 'storageModified': False,
            'requiredBeforeExecution': ['current-profile-and-original-owner', 'exact-source-and-task-receipts',
                                        'single-run-lock-and-persistent-six-call-counter',
                                        'application-budget-recheck', 'new-request-id-only-for-proven-no-outbound-case'],
            'notice': 'Preflight is not execution, model acceptance, or permission to bypass the application budget.'}


def main():
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--batch', type=Path, default=root / 'scratch/stage2c-model')
    args = parser.parse_args()
    try:
        result = preflight(root / 'examples/course-tasks/requirements-model-checks.json',
                           root / 'examples/course-tasks/requirements-original.json',
                           args.batch / 'summary.json', args.batch / 'outbound-count.json', args.batch / 'qa.db')
        print(json.dumps(result, ensure_ascii=False))
    except Exception as error:
        code = str(error) if str(error).startswith('resume-preflight-') else 'resume-preflight-input-unavailable'
        print(json.dumps({'status': 'blocked', 'errorCode': code, 'modelInvoked': False}))
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
