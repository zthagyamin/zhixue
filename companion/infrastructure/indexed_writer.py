"""One atomic indexed journal/projection write, including conditional file restoration."""
from __future__ import annotations
from pathlib import Path
import json
import hashlib
import index_gateway
import planning_evidence
import practice_engine
import state_projection
import review_queue
from study_event_schema import validate_study_event_v3
from infrastructure.native_common import _validate_local_context, _events_for_state, _restore_bytes


class IndexedStudyWriter:
    def __init__(self, now):
        self.now = now

    def accept(self, database, vault_root, account_id, event, context_raw, catalog, frozen, write_to_vault=True, attempt_binding=None, final_check=None):
        # Task evidence must only observe a journal after its owning practice transaction settles.
        with index_gateway.LOCK:
            return self._accept_locked(database, vault_root, account_id, event, context_raw, catalog, frozen, write_to_vault, attempt_binding, final_check)


    def _accept_locked(self, database, vault_root, account_id, event, context_raw, catalog, frozen, write_to_vault=True, attempt_binding=None, final_check=None):
        """Freeze local routing separately from the immutable portable event core."""
        now = self.now().isoformat(timespec="seconds")
        existing = database.execute("SELECT core_hash FROM study_events_v3 WHERE account_id = ? AND event_id = ?", (account_id, event["eventId"])).fetchone()
        if existing and existing[0] != event["coreHash"]:
            raise ValueError("event-conflict")
        receipt = database.execute("SELECT status FROM study_event_projections WHERE account_id = ? AND event_id = ?", (account_id, event["eventId"])).fetchone()
        if existing and (receipt is None or receipt[0] == "applied"):
            return {"status": "duplicate", "eventId": event["eventId"], "event": event, "projectionStatus": "applied", "mappingStatus": "mapped" if frozen and json.loads(frozen[0]).get("binding") else "unmapped", "companionReceipt": {"durable": True, "eventId": event["eventId"], "projectionStatus": "applied"}}
        if existing and not frozen:
            raise ValueError("legacy-pending-migration: 旧模式仍有待写回事件；请先完成旧映射写回，不能按新索引重新分配。")
        if frozen:
            route = json.loads(frozen[0])
            binding, context, card_path = route["binding"], route["context"], route["reviewCardPath"]
        else:
            binding, resolved = index_gateway.resolve_event_context(vault_root, catalog, event["item"]["key"], context_raw)
            context = _validate_local_context(resolved, vault_root)
            card = next((card for card in catalog.get("resultCards", []) if binding and card["itemId"] == binding["itemId"]), None)
            card_path = card["path"] if card else None
            review_name = str(card["reviewPoints"][0]).strip() if card and card.get("reviewPoints") else practice_engine.item_to_review_entry(event)["name"]
            route = {"mode": "indexed", "binding": binding, "context": context, "reviewCardPath": card_path, "reviewEntryName": review_name}
            from assistance_binding import admit_binding
            route.update(admit_binding(vault_root, event, binding, attempt_binding))
            if binding:
                prior = next((row for row in index_gateway.read_subject_events(vault_root, binding, account_id) if row['event']['eventId'] == event['eventId']), None)
                observation = prior.get('planningEvidence') if prior else planning_evidence.observe_before(vault_root, catalog, binding, event)
                if observation is not None:
                    route['planningEvidence'] = observation
        backups: dict[Path, bytes | None] = {}
        written: dict[Path, bytes] = {}
        written_hashes: dict[Path, str] = {}
        if binding:
            # Resolve every frozen target again to detect moved notes or junctions, never retarget it.
            for ref in {binding["stateRef"], binding["progressRef"]}:
                path, _ = index_gateway.resolve_reference(vault_root, ref)
                backups[path] = path.read_bytes()
            path = index_gateway.subject_event_path(vault_root, binding, event)
            backups[path] = path.read_bytes() if path.exists() else None
            if card_path:
                path, _ = index_gateway.resolve_reference(vault_root, card_path)
                backups[path] = path.read_bytes()
        try:
            if final_check:
                final_check()
            database.execute("INSERT OR IGNORE INTO study_events_v3(account_id,event_id,core_hash,occurred_at,event_json,local_context_json,accepted_at) VALUES (?,?,?,?,?,?,?)", (account_id,event["eventId"],event["coreHash"],event["occurredAt"],json.dumps(event,ensure_ascii=False),json.dumps(context,ensure_ascii=False),now))
            database.execute("INSERT OR IGNORE INTO study_event_bindings(account_id,event_id,binding_json) VALUES (?,?,?)", (account_id,event["eventId"],json.dumps(route,ensure_ascii=False)))
            status = "applied"
            projection_payload = None
            if binding and write_to_vault:
                journal_path = index_gateway.record_subject_event(vault_root, binding, account_id, event, context, route.get('planningEvidence'))
                written[journal_path] = journal_path.read_bytes()
                roots = {item['recordsRoot']: item for item in [*catalog.get('recordRoots',[]), *catalog.get('bindings',{}).values()]}
                roots[binding['recordsRoot']] = binding
                journals = [(root, index_gateway.read_subject_events(vault_root, local, account_id)) for root, local in roots.items()]
                for ref in dict.fromkeys([binding["stateRef"], binding["progressRef"]]):
                    grouped = _events_for_state(database, account_id, ref)
                    for root, journal in journals:
                        for row in journal:
                            local = row.get("localContext", {})
                            if (ref == binding["progressRef"] and root == binding['recordsRoot']) or local.get("stateRef") == ref:
                                ability = local.get("abilityId")
                                if ability:
                                    grouped.setdefault(ability, []).append(validate_study_event_v3(row["event"]))
                    grouped = {ability: list({item["eventId"]: item for item in values}.values()) for ability, values in grouped.items()}
                    ability = binding["abilityId"]
                    target = (vault_root / ref).resolve()
                    projection = state_projection.project_mapped_events(vault_root, ref, ability, grouped.get(ability, []), ability_events=grouped, expected_text=backups[target].decode('utf-8'))
                    written[target] = target.read_bytes()
                    projection_payload = {"status": projection.status, "eventCount": projection.event_count, "latestAt": projection.latest_at}
                if card_path and event["eventType"] == "practice-attempt":
                    try:
                        target = (vault_root / card_path).resolve()
                        expected = backups[target].decode('utf-8').replace('\r\n','\n').replace('\r','\n')
                        review_result = review_queue.apply_result(vault_root, card_path, {"name": route['reviewEntryName']}, event["attempt"]["rating"], expected_text=expected, event_id=event["eventId"])
                        if not review_result.get('duplicate'):
                            written_hashes[target] = review_result['writtenHash']
                            observation = planning_evidence.with_after(review_result['afterReview'], route.get('planningEvidence'), event)
                            planning_evidence.update_record(vault_root, binding, account_id, event, observation)
                            route['planningEvidence'] = observation
                            written[journal_path] = journal_path.read_bytes()
                            database.execute('UPDATE study_event_bindings SET binding_json = ? WHERE account_id = ? AND event_id = ?',
                                (json.dumps(route, ensure_ascii=False), account_id, event['eventId']))
                    except ValueError as error:
                        if str(error) != "stale-vault-edit":
                            raise
                        status = "pending"
            database.execute("INSERT INTO study_event_projections(account_id,event_id,status,updated_at) VALUES (?,?,?,?) ON CONFLICT(account_id,event_id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at", (account_id,event["eventId"],status,now))
            if final_check:
                final_check()
            database.commit()
        except Exception:
            database.rollback()
            if write_to_vault:
                for path, own_version in written.items():
                    if path not in written_hashes and path.exists() and path.read_bytes() == own_version:
                        _restore_bytes(path, backups[path])
                for path, own_hash in written_hashes.items():
                    if path.exists() and hashlib.sha256(path.read_bytes()).hexdigest() == own_hash:
                        _restore_bytes(path, backups[path])
            raise
        return {"status": "accepted", "eventId": event["eventId"], "event": event, "mappingStatus": "mapped" if binding else "unmapped", "projectionStatus": status,
                "stateProjection": projection_payload, "companionReceipt": {"durable": True, "eventId": event["eventId"], "projectionStatus": status, "stateProjection": projection_payload},
                **({"message": "学习事件已写入所属学科；结果卡变动，队列写回等待重试。"} if status == "pending" else {})}
