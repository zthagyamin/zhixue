"""Exact route registration with one preserved account-sync prefix fallback."""
from __future__ import annotations

import routes_account
import routes_study
import routes_planning
import routes_sources
import routes_ai
import routes_course
import routes_math


def _register(entries):
    routes = {}
    for path, handler in entries:
        if path in routes:
            raise ValueError(f'duplicate-http-route: {path}')
        routes[path] = handler
    return routes

GET_ROUTES = _register([
    ('/v1/papers', routes_sources.get_papers),
    ('/v1/vocabulary/target', routes_sources.get_vocabulary_target),
    ('/v1/note-sources', routes_sources.get_note_sources),
    ('/v1/setup', routes_sources.get_note_sources),
    ('/v1/vault-mapping', routes_sources.get_vault_mapping),
    ('/v1/account-sync/status', routes_account.get_account_sync_status),
    ('/v1/study-data', routes_study.get_study_data),
    ('/v1/dashboard/today', routes_study.get_dashboard_today),
    ('/v1/diagnostics', routes_study.get_diagnostics),
    ('/v1/tasks/events', routes_planning.get_tasks_events),
    ('/v1/plan/evidence', routes_planning.get_plan_evidence),
    ('/v1/plan/context', routes_planning.get_plan_context),
    ('/v1/plan/current', routes_planning.get_plan_current),
    ('/v1/constraints', routes_planning.get_constraints),
    ('/v1/changes', routes_sources.get_changes),
    ('/v1/capture', routes_sources.get_capture),
    ('/v1/practice', routes_study.get_practice),
    ('/v1/audit', routes_sources.get_audit),
])

POST_ROUTES = _register([
    ('/v1/math/source/capture', routes_math.post_math),
    ('/v1/math/source/read', routes_math.post_math),
    ('/v1/math/mapping/publish', routes_math.post_math),
    ('/v1/math/mapping/read', routes_math.post_math),
    ('/v1/math/variant', routes_math.post_math),
    ('/v1/math/claim', routes_math.post_math),
    ('/v1/math/evaluate', routes_math.post_math),
    ('/v1/math/read', routes_math.post_math),
    ('/v1/course/grade', routes_course.post_course_grade),
    ('/v1/course/claim', routes_course.post_course_grade),
    ('/v1/course/source/capture', routes_course.post_course_source),
    ('/v1/course/source/read', routes_course.post_course_source),
    ('/v1/papers/read', routes_sources.post_papers_read),
    ('/v1/papers/material', routes_sources.post_papers_read),
    ('/v1/papers/save', routes_sources.post_papers_read),
    ('/v1/papers/figure', routes_sources.post_papers_read),
    ('/v1/vocabulary/append', routes_sources.post_vocabulary_append),
    ('/v1/note-sources', routes_sources.post_note_sources),
    ('/v1/setup', routes_sources.post_note_sources),
    ('/v1/vault-mapping', routes_sources.post_vault_mapping),
    ('/v1/activity', routes_study.post_activity),
    ('/v1/assistance', routes_study.post_assistance),
    ('/v1/hint', routes_ai.post_hint),
    ('/v1/correct-card', routes_ai.post_correct_card),
    ('/v1/generate', routes_ai.post_generate),
    ('/v1/refresh', routes_study.post_refresh),
    ('/v1/session/revoke', routes_account.post_session_revoke),
    ('/v1/tasks/events', routes_planning.post_tasks_events),
    ('/v1/plan/suggest', routes_planning.post_plan_suggest),
    ('/v1/plan/ai-reorder', routes_planning.post_plan_ai_reorder),
    ('/v1/plan/apply', routes_planning.post_plan_apply),
    ('/v1/plan/reject', routes_planning.post_plan_reject),
    ('/v1/plan/restore', routes_planning.post_plan_restore),
    ('/v1/constraints', routes_planning.post_constraints),
    ('/v1/changes/scan', routes_sources.post_changes_scan),
    ('/v1/changes/decide', routes_sources.post_changes_decide),
    ('/v1/events/archive', routes_sources.post_events_archive),
    ('/v1/sources/init', routes_sources.post_sources_init),
    ('/v1/capture', routes_sources.post_capture),
    ('/v1/practice/grade', routes_study.post_practice_grade),
    ('/v1/practice/variant', routes_study.post_practice_variant),
    ('/v1/ai/settings', routes_ai.post_ai_settings),
    ('/v1/ai/configure', routes_ai.post_ai_settings),
    ('/v1/ai/chat', routes_ai.post_ai_settings),
    ('/v1/ai/models', routes_ai.post_ai_settings),
    ('/v1/settings/deepseek', routes_ai.post_settings_deepseek),
])


def dispatch(method, path, request, services, account, payload=None):
    handler = (GET_ROUTES if method == 'GET' else POST_ROUTES if method == 'POST' else {}).get(path)
    if handler is None and method == 'POST' and path.startswith('/v1/account-sync/'):
        handler = routes_account.post_account_sync
    if handler is None:
        return False
    handler(request, services, path, account, payload)
    return True
