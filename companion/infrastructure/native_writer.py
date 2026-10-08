"""Native event persistence adapter. Database and filesystem form one recovery boundary."""
from __future__ import annotations
from study_day import study_day
from dataclasses import dataclass
from datetime import date, datetime, tzinfo
from pathlib import Path
from typing import Any, Callable, ContextManager
import sqlite3
import json
import secrets
import index_gateway
import learning_result
import practice_engine
import review_queue
import state_projection
from study_event_schema import ensure_study_v3_schema, validate_study_event_v3, STUDY_V3_SCHEMA_VERSION, STUDY_V3_RATINGS
from infrastructure.native_common import _validate_local_context, _events_for_state, _restore_bytes
from infrastructure.indexed_writer import IndexedStudyWriter


@dataclass(frozen=True)
class NativeWritePorts:
    now: Callable[[], datetime]
    local_tz: tzinfo
    lock: ContextManager[Any]
    gateway: Callable[..., dict]
    dashboard: Callable[..., dict]
    log_path: Callable[[date], Path]
    vault_path: Callable[[str], Path]
    read_activity: Callable[[date], list]
    render_report: Callable[[date, list], Path]
    report_events: Callable[[date], list]
    relative_path: Callable[[Path], str]
    course_guard: Callable[..., Callable[[], None] | None] | None = None


class NativeStudyWriter:
    def __init__(self, ports: NativeWritePorts):
        self.ports = ports
        self.indexed = IndexedStudyWriter(ports.now)

    def accept(self,
        database: sqlite3.Connection,
        vault_root: Path,
        account_id: str,
        payload: dict[str, Any],
        write_to_vault: bool = True,
    ) -> dict[str, Any]:
        ensure_study_v3_schema(database)
        if not isinstance(payload, dict):
            raise ValueError("invalid-study-event-v3-payload")
        event_raw = payload.get("event")
        local_context_raw = payload.get("localContext")
        event = validate_study_event_v3(event_raw)
        frozen = database.execute(
            "SELECT binding_json FROM study_event_bindings WHERE account_id = ? AND event_id = ?",
            (account_id, event["eventId"]),
        ).fetchone()
        catalog = self.ports.gateway(vault_root)
        final_check = self.ports.course_guard(database, vault_root, account_id, event, catalog) if self.ports.course_guard else None
        if frozen or (catalog["active"] and (not catalog.get("legacyCoexistence") or index_gateway.lookup_binding(catalog, event["item"]["key"]))):
            with self.ports.lock:
                return self.indexed.accept(database, vault_root, account_id, event, local_context_raw, catalog, frozen, write_to_vault, payload.get('attemptBinding'), final_check)
        local_context = _validate_local_context(local_context_raw, vault_root)

        now = self.ports.now().isoformat(timespec="seconds")
        existing = database.execute(
            "SELECT core_hash, local_context_json FROM study_events_v3 WHERE account_id = ? AND event_id = ?",
            (account_id, event["eventId"]),
        ).fetchone()
        if existing:
            if existing[0] == event["coreHash"]:
                database.execute(
                    "INSERT INTO study_event_stats(account_id, duplicate_count, conflict_count, updated_at) VALUES (?, 1, 0, ?) "
                    "ON CONFLICT(account_id) DO UPDATE SET duplicate_count = duplicate_count + 1, updated_at = excluded.updated_at",
                    (account_id, now),
                )
                projection = database.execute(
                    "SELECT status FROM study_event_projections WHERE account_id = ? AND event_id = ?",
                    (account_id, event["eventId"]),
                ).fetchone()
                if projection is None or projection[0] == "applied":
                    return {"status": "duplicate", "eventId": event["eventId"], "mappingStatus": "unmapped", "event": event, "projectionStatus": "applied"}
                # A retry is the same immutable event, using its original local mapping.
                local_context = json.loads(existing[1]) if existing[1] else {}
            else:
                database.execute(
                    "INSERT INTO study_event_stats(account_id, duplicate_count, conflict_count, updated_at) VALUES (?, 0, 1, ?) "
                    "ON CONFLICT(account_id) DO UPDATE SET conflict_count = conflict_count + 1, updated_at = excluded.updated_at",
                    (account_id, now),
                )
                # Keep the diagnostic counter when the caller rolls back its transaction.
                database.commit()
                raise ValueError("event-conflict")

        mapping_status = "unmapped"
        state_handle: str | None = None
        state_ref = local_context.get("stateRef")
        ability_id = local_context.get("abilityId")
        if state_ref and ability_id:
            mapping_status = "mapped"
            # The first handle assigned to a (state_ref, ability_id) mapping stays
            # stable so previously accepted events can still resolve their handle
            # back to the local path; later events reuse the same opaque handle.
            database.execute(
                "INSERT OR IGNORE INTO state_handles(account_id, state_handle, state_ref, ability_id, created_at) VALUES (?, ?, ?, ?, ?)",
                (account_id, secrets.token_urlsafe(24), state_ref, ability_id, now),
            )
            handle_row = database.execute(
                "SELECT state_handle FROM state_handles WHERE account_id = ? AND state_ref = ? AND ability_id = ?",
                (account_id, state_ref, ability_id),
            ).fetchone()
            state_handle = str(handle_row[0])

        database.execute(
            "INSERT OR IGNORE INTO study_events_v3(account_id, event_id, core_hash, occurred_at, event_json, local_context_json, accepted_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (
                account_id,
                event["eventId"],
                event["coreHash"],
                event["occurredAt"],
                json.dumps(event, ensure_ascii=False),
                json.dumps(local_context, ensure_ascii=False) if local_context else None,
                now,
            ),
        )
        database.execute(
            "INSERT INTO study_event_stats(account_id, duplicate_count, conflict_count, updated_at) VALUES (?, 0, 0, ?) "
            "ON CONFLICT(account_id) DO UPDATE SET updated_at = excluded.updated_at",
            (account_id, now),
        )

        event_day: date
        try:
            occurred = datetime.fromisoformat(event["occurredAt"].replace("Z", "+00:00")).astimezone(self.ports.local_tz)
            event_day = study_day(occurred)
        except ValueError:
            event_day = study_day(self.ports.now())
        vault_record = {**event, **local_context}
        vault_record["schemaVersion"] = STUDY_V3_SCHEMA_VERSION
        vault_record["outcome"] = "completed" if event.get("attempt", {}).get("correct", False) else "needs-review"
        vault_record["receivedAt"] = now

        result: dict[str, Any] = {
            "status": "accepted",
            "eventId": event["eventId"],
            "mappingStatus": mapping_status,
            "event": event,
            "dashboard": self.ports.dashboard(event_day),
            "projectionStatus": "applied",
        }
        if mapping_status == "mapped":
            result["stateHandle"] = state_handle
        if not write_to_vault:
            database.commit()
            result["companionReceipt"] = {"durable": True, "eventId": event["eventId"], "stateProjection": None}
            return result

        log_path = self.ports.log_path(event_day)
        report_path = self.ports.vault_path(f"_System/Reports/Daily/{event_day.year}/{event_day.isoformat()} 学习同步.md")
        state_path = self.ports.vault_path(state_ref) if mapping_status == "mapped" else None
        previous_log = log_path.read_bytes() if log_path.exists() else None
        previous_report = report_path.read_bytes() if report_path.exists() else None
        previous_state = state_path.read_bytes() if state_path is not None and state_path.exists() else None
        # Task 9: practice events write back to the learning result card's review
        # queue. The rating lives in the validated attempt (already restricted to
        # STUDY_V3_RATINGS); the item key is the practice item identity the website
        # sends as event.item.key. Result cards are matched by itemId first, then
        # by stateRef, and mapped events are eligible.
        review_card_path: str | None = None
        rating = str(event.get("attempt", {}).get("rating", ""))
        if rating in STUDY_V3_RATINGS:
            # 主路径：mapped 事件按 stateRef + item.key 定位结果卡（.md / wikilink
            # 归一化在 result_card_for_state 内完成）。
            if mapping_status == "mapped":
                review_card_path = state_projection.result_card_for_state(
                    vault_root, state_ref, item_id=event.get("item", {}).get("key"), ability_id=ability_id
                )
            # 硬化：生产客户端只转发 .md 结尾的 stateRef（markdownNotePath），而
            # 结果卡存的是不带 .md 的 wikilink 目标，练习事件因此经常以 unmapped
            # 到达。只要 item.key 携带 "practice:{itemId}" 且命中结果卡，写回仍
            # 必须发生，否则卡片练习永远不会写回 Vault 队列。
            if review_card_path is None and mapping_status != "mapped":
                item_key = event.get("item", {}).get("key")
                if isinstance(item_key, str) and item_key.startswith("practice:"):
                    review_card_path = state_projection.result_card_for_state(vault_root, "", item_id=item_key, ability_id=ability_id)
        # Name the queue entry after the card's first review point so the line is
        # meaningful; fall back to the event-derived name when the card has none.
        review_entry_name = practice_engine.item_to_review_entry(event)["name"]
        if review_card_path is not None:
            matched_card = next(
                (
                    card
                    for card in learning_result.parse_result_cards(vault_root)
                    if card["path"] == review_card_path
                ),
                None,
            )
            if matched_card and matched_card.get("reviewPoints"):
                first_point = str(matched_card["reviewPoints"][0]).strip()
                if first_point:
                    review_entry_name = first_point
        previous_review_card: bytes | None = None
        if review_card_path is not None and (vault_root / review_card_path).exists():
            previous_review_card = (vault_root / review_card_path).read_bytes()
        try:
            with self.ports.lock:
                log_path.parent.mkdir(parents=True, exist_ok=True)
                existing_events = self.ports.read_activity(event_day)
                if not any(item.get("eventId") == event["eventId"] for item in existing_events):
                    with log_path.open("a", encoding="utf-8", newline="\n") as handle:
                        handle.write(json.dumps(vault_record, ensure_ascii=False, separators=(",", ":")) + "\n")
                    rendered_report = self.ports.render_report(event_day, self.ports.report_events(event_day))
                    result["dailyReport"] = self.ports.relative_path(rendered_report)
                if mapping_status == "mapped" and state_ref and ability_id:
                    ability_events = _events_for_state(database, account_id, state_ref)
                    projection = state_projection.project_mapped_events(
                        vault_root,
                        state_ref,
                        ability_id,
                        ability_events.get(ability_id, []),
                        ability_events=ability_events,
                    )
                    result["stateProjection"] = {
                        "status": projection.status,
                        "eventCount": projection.event_count,
                        "latestAt": projection.latest_at,
                    }
                if review_card_path is not None:
                    # spec §9：写回前核对文件哈希（expected_text），用户已同时编辑
                    # 卡片则跳过队列写回并提示，绝不覆盖用户编辑。事件本身已提交
                    # （eventId 幂等），队列更新是带冲突保护的最佳努力操作。
                    review_card_text: str | None = None
                    review_card_full = vault_root / review_card_path
                    if review_card_full.exists():
                        review_card_text = review_card_full.read_text(encoding="utf-8")
                    try:
                        review_queue.apply_result(
                            vault_root,
                            review_card_path,
                            {"name": review_entry_name},
                            rating,
                            note="；".join(str(part) for part in (local_context.get("weakPoints") or [])),
                            expected_text=review_card_text,
                            event_id=event["eventId"],
                        )
                    except ValueError as conflict:
                        if str(conflict) != "stale-vault-edit":
                            raise
                        result["projectionStatus"] = "pending"
                        result["message"] = "学习事件已保存；结果卡正在编辑，队列写回等待重试。"
            database.execute(
                "INSERT INTO study_event_projections(account_id, event_id, status, updated_at) VALUES (?, ?, ?, ?) "
                "ON CONFLICT(account_id, event_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at",
                (account_id, event["eventId"], result["projectionStatus"], now),
            )
            database.commit()
        except Exception:
            database.rollback()
            _restore_bytes(log_path, previous_log)
            _restore_bytes(report_path, previous_report)
            if state_path is not None:
                _restore_bytes(state_path, previous_state)
            if review_card_path is not None and previous_review_card is not None:
                _restore_bytes(vault_root / review_card_path, previous_review_card)
            raise
        result["companionReceipt"] = {
            "durable": True,
            "eventId": event["eventId"],
            "stateProjection": result.get("stateProjection"),
            "projectionStatus": result["projectionStatus"],
        }
        return result
