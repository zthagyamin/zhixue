"""Filesystem, locks and legacy planning codecs behind explicit application ports."""
from __future__ import annotations
from contextlib import contextmanager
from datetime import UTC, datetime
import constraint_area
import index_gateway
import plan_area
import plan_suggestions
import planning_catalog
import planning_evidence
import task_events
import task_plan_schema
from application.planning import PlanningApplication, PlanningPorts


def create_planning_application(services) -> PlanningApplication:
    selected = []

    def vault():
        if not selected:
            selected.append(services.source_path('learning_vault_root'))
        return selected[0]

    @contextmanager
    def evidence_lock():
        with plan_area.PLAN_LOCK, index_gateway.LOCK:
            yield

    return PlanningApplication(PlanningPorts(
        vault_available=lambda: vault().exists(),
        gateway=lambda: services.effective_gateway(vault()),
        catalog=lambda gateway: planning_catalog.load_planning_catalog(vault(), gateway),
        verify_catalog=lambda gateway, catalog: planning_evidence.verify_catalog_snapshot(vault(), gateway, catalog, catalog_loader=services.effective_gateway),
        revision=lambda: plan_area.current_revision(plan_area.plan_area_root(vault())),
        task_page=lambda catalog, owner, after: task_events.task_event_page(vault(), catalog, owner, after),
        evidence_page=lambda gateway, owner, source_hash, revision, after: planning_evidence.evidence_page(vault(), gateway, owner, services.validate_study_event_v3, source_hash=source_hash, plan_revision=revision, after=after),
        context=lambda gateway, owner: planning_evidence.build_context(vault(), gateway, owner, services.validate_study_event_v3, catalog_loader=services.effective_gateway),
        current_plan=lambda: plan_area.current_payload(plan_area.plan_area_root(vault())),
        default_constraints=lambda: constraint_area.default_constraints(datetime.now(UTC)),
        constraints=lambda owner, now=None: services.effective_constraints(vault(), owner, now) if now is not None else services.effective_constraints(vault(), owner),
        append_task=lambda catalog, owner, event: task_events.append_task_event(vault(), catalog, owner, event, validate_practice_event=services.validate_study_event_v3),
        parse_suggestion=plan_suggestions.parse_request,
        suggest=lambda catalog, request: plan_suggestions.suggest_tasks(catalog, request, services.suggestion_ai),
        reorder=lambda items: services.reorder_plan_with_deepseek(items),
        validate_plan=task_plan_schema.validate_task_plan_integrity,
        plan_lock=lambda: plan_area.PLAN_LOCK,
        evidence_lock=evidence_lock,
        constraint_lock=lambda: constraint_area.CONSTRAINT_LOCK,
        apply=lambda candidate, operator, expected: plan_area.apply_plan_revision(plan_area.plan_area_root(vault()), candidate, operator, 'website-approval', expected_revision=expected),
        reject=lambda candidate, operator, reason: plan_area.reject_candidate(plan_area.plan_area_root(vault()), candidate, operator, reason),
        restore=lambda target, operator, expected: plan_area.restore_revision(plan_area.plan_area_root(vault()), target, operator, expected_revision=expected),
        write_constraints=lambda document, now: constraint_area.write_constraints(vault(), document, now),
        now=lambda: datetime.now(UTC),
    ))
