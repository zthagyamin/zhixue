from __future__ import annotations
from study_day import study_day, CAPABILITY as STUDY_DAY_CAPABILITY

import json
import hashlib
import hmac
import os
import re
import secrets
import sqlite3
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from contextlib import contextmanager
from datetime import UTC, date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Iterator
from zoneinfo import ZoneInfo

import http_routes
from route_services import RouteServices
from study_event_schema import (
    STUDY_V3_SCHEMA_VERSION,
    SCHEDULER_VERSION,
    STUDY_V3_RATINGS,
    STUDY_V3_DOMAINS,
    STUDY_V3_ITEM_KINDS,
    STUDY_V3_EVENT_TYPES,
    STUDY_V3_FORBIDDEN_KEYS,
    STUDY_V3_HASH_EXCLUDED_KEYS,
    MAX_EVENT_BYTES,
    MAX_IDENTIFIER_CHARACTERS,
    STUDY_V3_SCHEMA,
    canonicalize_json,
    study_event_hash_input,
    compute_study_event_core_hash,
    ensure_study_v3_schema,
    scan_forbidden_cloud_keys,
    _require_string,
    _require_iso_date,
    _require_known_keys,
    _parse_item,
    _parse_attempt,
    _parse_scheduling,
    _parse_baseline_state,
    validate_study_event_v3,
)

import study_ai_provider
import audit_diag
import capture_store
import change_detect
import constraint_area
import events_archive
import history_estimator
import index_gateway
import assistance_sync
import learning_result
import learning_session
import plan_area
import planning_catalog
import planning_evidence
import plan_suggestions
import practice_engine
import review_queue
import snapshot_schema
import source_area
import vault_topology
from vault_identity import local_vault_library_id
import state_projection
import task_events
import task_plan_schema
import account_sync_local_api
import account_sync_service
import external_sources
import note_source_api
import note_source_runtime
import companion_setup
from account_sync_schema import study_hash as account_study_hash


ROOT = Path(__file__).resolve().parent
CONFIG_PATH = ROOT / "config.local.json"
CONFIG_TEMPLATE_PATH = ROOT / "config.json"
SEED_PATH = ROOT / "data" / "seed.json"
ENV_PATH = ROOT / ".env.local"
LOCAL_DATABASE_PATH = ROOT / "data" / "study-loop.db"
ACCOUNT_SYNC_SERVICE = None
ACCOUNT_SYNC_SERVICE_KEY = None
ACCOUNT_SYNC_SERVICE_LOCK = threading.Lock()
NOTE_SOURCE_RUNTIME = None
NOTE_SOURCE_LOCK = threading.RLock()
MAX_UPLOAD_BYTES = 1_500_000
DATA_LOCK = threading.Lock()
LOCAL_TZ = ZoneInfo("Asia/Shanghai")
EVENT_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{5,127}$")
EVENT_DOMAINS = {"differential-review", "python", "ielts", "course", "paper", "project", "other"}
EVENT_OUTCOMES = {"completed", "partial", "needs-review"}
SUPPORTED_NOTE_SUFFIXES = {".md", ".txt", ".pdf"}
PAIRING_CODE = secrets.token_hex(3).upper()
PAIRING_FAILURES = 0
PAIRING_LOCK = threading.Lock()
CREDENTIAL_SERVICE = "zhixue-study-loop"
SESSION_TTL_DAYS = 30


def load_local_env() -> None:
    if not ENV_PATH.exists():
        return
    for raw_line in ENV_PATH.read_text(encoding="utf-8-sig").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ[key.strip()] = value.strip().strip('"').strip("'")


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8-sig"))


def ensure_subject_payload(payload: dict[str, Any]) -> dict[str, Any]:
    from application.generated_content import ensure_subject_payload as normalize
    return normalize(payload)


load_local_env()
CONFIG = load_json(CONFIG_PATH if CONFIG_PATH.exists() else CONFIG_TEMPLATE_PATH)
SEED = ensure_subject_payload(load_json(SEED_PATH))
STATE: dict[str, Any] = {**SEED, "status": "key_missing" if not os.getenv("DEEPSEEK_API_KEY") else "offline"}
LAST_SIGNATURE: tuple[str, ...] | None = None
CHANGE_SCAN_STATUS: dict[str, Any] = {"scannedAt": None, "pendingCount": 0, "error": None}

LEGACY_MODEL_DEFAULT = "deepseek-chat"
CURRENT_MODEL_DEFAULT = "deepseek-v4-flash"
DEEPSEEK_RETRY_ATTEMPTS = 2
DEEPSEEK_RETRY_DELAY_SECONDS = 0.5


class DeepSeekUnavailableError(RuntimeError):
    """A transient provider/network failure that should not look like a Companion crash."""


def open_deepseek(request: urllib.request.Request, timeout: float):
    from infrastructure.legacy_transport import LegacyProviderTransport
    return LegacyProviderTransport(settings=ai_settings, key=deepseek_key,
        attempts=DEEPSEEK_RETRY_ATTEMPTS, delay=DEEPSEEK_RETRY_DELAY_SECONDS,
        unavailable=DeepSeekUnavailableError).open(request, timeout)


def migrate_legacy_config() -> None:
    """One-time migration of the legacy shipped model default for deployed configs.

    Older installs copied the template's ``deepseek-chat`` into ``config.local.json``
    before the code default moved to ``deepseek-v4-flash``. Update those files in place
    so the runtime and the shipped default agree, without reverting an explicit choice
    the user makes afterwards.
    """
    if CONFIG.get("deepseek_model") != LEGACY_MODEL_DEFAULT:
        return
    if CONFIG.get("deepseek_model_migrated"):
        return
    CONFIG["deepseek_model"] = CURRENT_MODEL_DEFAULT
    CONFIG["deepseek_model_migrated"] = True
    if CONFIG_PATH.exists():
        try:
            CONFIG_PATH.write_text(json.dumps(CONFIG, ensure_ascii=False, indent=2), encoding="utf-8")
        except Exception:
            # Best effort: the in-memory value is already updated for this session.
            pass


migrate_legacy_config()


def companion_version() -> str:
    """Read the packaged companion version from version.json (falls back safely)."""
    try:
        return str(load_json(ROOT / "version.json").get("version", "0.0.0"))
    except Exception:
        return "0.0.0"


def credential_account(hashed_user: str | None) -> str:
    return f"deepseek-api-key-{(hashed_user or 'unpaired')[:16]}"


def installation_owner_hash() -> str | None:
    with local_database() as database:
        row = database.execute("SELECT user_hash FROM installation_owner WHERE singleton = 1").fetchone()
        return str(row[0]) if row else None


def credential_key(hashed_user: str | None = None) -> str | None:
    try:
        import keyring
        return keyring.get_password(CREDENTIAL_SERVICE, credential_account(hashed_user or installation_owner_hash()))
    except Exception:
        return None


def ai_store(database):
    import keyring
    return study_ai_provider.SettingsStore(database, keyring, CREDENTIAL_SERVICE, CONFIG,
        lambda owner: credential_key(owner) or os.getenv("DEEPSEEK_API_KEY"))


def ai_scope():
    return installation_owner_hash() or 'unpaired', local_vault_library_id(source_path('learning_vault_root'))


def ai_settings():
    owner, library = ai_scope()
    with local_database() as database:
        return ai_store(database).get(owner, library)


def deepseek_key() -> str | None:
    """Compatibility name: returns the selected provider credential, never another provider's key."""
    owner, library = ai_scope()
    with local_database() as database:
        return ai_store(database).key(owner, library)


def save_deepseek_key(value: str, hashed_user: str) -> None:
    key = value.strip()
    if len(key) < 12 or len(key) > 512:
        raise ValueError("API Key 格式无效。")
    try:
        import keyring
    except ModuleNotFoundError as error:
        raise RuntimeError("缺少系统凭据库组件，请双击 install-companion.cmd 完成安装后重试。") from error
    try:
        with study_ai_provider.SETTINGS_LOCK:
            keyring.set_password(CREDENTIAL_SERVICE, credential_account(hashed_user), key)
    except Exception as error:
        error_code = getattr(error, "winerror", None)
        if error_code is None and error.args and isinstance(error.args[0], int):
            error_code = error.args[0]
        if error_code == 1312:
            raise RuntimeError(
                "当前 Companion 未运行在你的 Windows 桌面会话中，无法使用系统凭据库。"
                "请关闭当前 Companion，再从网页点击“启动 Companion”或双击 start-companion.cmd 后重试。"
            ) from error
        raise RuntimeError("Windows 系统凭据库暂时不可用，请从桌面重新启动 Companion 后重试。") from error


def installation_user_hash(database: sqlite3.Connection, user_id: str) -> str:
    row = database.execute("SELECT value FROM installation_metadata WHERE key = 'user_hash_salt'").fetchone()
    if row:
        salt = bytes.fromhex(str(row[0]))
    else:
        salt = secrets.token_bytes(32)
        database.execute("INSERT INTO installation_metadata(key, value) VALUES ('user_hash_salt', ?)", (salt.hex(),))
    return hmac.new(salt, user_id.encode("utf-8"), hashlib.sha256).hexdigest()


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def get_account_sync_service():
    """Construct lazily; module import never reads new credentials or starts sync."""
    global ACCOUNT_SYNC_SERVICE, ACCOUNT_SYNC_SERVICE_KEY
    origins = tuple(CONFIG.get('allowed_origins', []))
    key = (str(LOCAL_DATABASE_PATH.resolve()), origins)
    with ACCOUNT_SYNC_SERVICE_LOCK:
        if ACCOUNT_SYNC_SERVICE is not None and ACCOUNT_SYNC_SERVICE_KEY != key:
            ACCOUNT_SYNC_SERVICE.shutdown()
            ACCOUNT_SYNC_SERVICE = None
        if ACCOUNT_SYNC_SERVICE is None:
            import keyring
            ACCOUNT_SYNC_SERVICE = account_sync_service.AccountSyncService(
                LOCAL_DATABASE_PATH.parent, LOCAL_DATABASE_PATH, lambda: source_path('learning_vault_root'), origins, keyring,
                planning_provider=account_sync_planning_context,content_processor=account_sync_content_decisions,
                catalog_loader=lambda vault, owner, refresh=False: effective_gateway(vault, refresh=refresh, owner=owner))
            ACCOUNT_SYNC_SERVICE_KEY = key
        return ACCOUNT_SYNC_SERVICE


def account_sync_planning_context(vault_root, gateway_catalog, owner):
    context=planning_evidence.build_context(vault_root,gateway_catalog,owner,validate_study_event_v3,catalog_loader=effective_gateway)
    context['legacyEvents']=[validate_study_event_v3(event) for event in index_gateway.progress_events(vault_root,gateway_catalog,owner)]
    context['legacyTaskEvents']=task_events.read_task_events(vault_root,gateway_catalog,owner)
    with local_database() as database:
        candidates=[]
        for capture in capture_store.pending_captures(database):
            fingerprint=str(capture.get('contentFingerprint',''));capture_id=str(capture.get('captureId',''))
            if capture.get('evidence')!='speculative' or not re.fullmatch(r'[a-f0-9]{64}',fingerprint) or not capture_id or len(capture_id)>180 or any(character in capture_id for character in '/\\') or any(ord(character)<32 or ord(character)==127 for character in capture_id):continue
            label=''.join(character for character in str(capture.get('summary') or capture.get('itemId') or '学习内容候选').strip() if ord(character)>=32 and ord(character)!=127)[:200]
            if label:candidates.append({'candidateId':'capture:'+capture_id,'kind':'added','label':label,'contentHash':fingerprint})
        context['contentCandidates']=candidates
    context['historyComplete']=True
    return context


def _remove_capture_pending(vault_root, capture_id):
    directory=snapshot_schema.ensure_sources_dirs(vault_root)['pending']
    for path in directory.glob('*.json'):
        try:
            if json.loads(path.read_text(encoding='utf-8')).get('captureId')==capture_id:path.unlink()
        except (OSError,ValueError,json.JSONDecodeError):continue


def account_sync_content_decisions(vault_root, owner, operations):
    """Execute only a locally re-discovered immutable candidate; cloud sends no path."""
    results=[]
    with local_database() as database:
        database.execute('CREATE TABLE IF NOT EXISTS account_content_decision_log(operation_id TEXT PRIMARY KEY,candidate_id TEXT NOT NULL,content_hash TEXT NOT NULL,decision TEXT NOT NULL,proof_hash TEXT NOT NULL)')
        database.execute("CREATE TABLE IF NOT EXISTS account_content_decision_jobs(operation_id TEXT PRIMARY KEY,candidate_id TEXT NOT NULL,content_hash TEXT NOT NULL,decision TEXT NOT NULL,capture_id TEXT NOT NULL,snapshot_json TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',proof_hash TEXT)")
        current={candidate['changeId']:candidate for candidate in change_detect.detect_changes(database,vault_root)}
        captures={str(capture.get('captureId')):capture for capture in capture_store.pending_captures(database)}
        for operation in operations:
            candidate=current.get(operation['candidateId'])
            try:
                stored=database.execute('SELECT * FROM account_content_decision_log WHERE operation_id=?',(operation['operationId'],)).fetchone()
                if stored:
                    if tuple(stored[1:4])!=(operation['candidateId'],operation['contentHash'],operation['decision']):raise ValueError('content-operation-conflict')
                    proof=stored[4];results.append({'schemaVersion':1,'receiptId':'content-receipt:'+account_study_hash([operation['operationId'],proof]),'operationId':operation['operationId'],'candidateId':operation['candidateId'],'contentHash':operation['contentHash'],'decision':operation['decision'],'status':'applied','proofHash':proof});continue
                if operation['candidateId'].startswith('capture:'):
                    job=database.execute('SELECT * FROM account_content_decision_jobs WHERE operation_id=?',(operation['operationId'],)).fetchone();capture_id=operation['candidateId'][8:]
                    if job:
                        if tuple(job[1:4])!=(operation['candidateId'],operation['contentHash'],operation['decision']) or job[4]!=capture_id:raise ValueError('content-operation-conflict')
                        snapshot=json.loads(job[5]);proof=job[7]
                    else:
                        capture=captures.get(capture_id)
                        if not capture or capture.get('contentFingerprint')!=operation['contentHash']:raise ValueError('source-change-stale')
                        snapshot=snapshot_schema.build_snapshot({key:capture[key] for key in ('captureId','itemId','domain','sourceNote','stateRef','abilityId','contentFingerprint','pluginType','planRevision')});snapshot_schema.validate_snapshot(snapshot)
                        database.execute('INSERT INTO account_content_decision_jobs(operation_id,candidate_id,content_hash,decision,capture_id,snapshot_json) VALUES(?,?,?,?,?,?)',(operation['operationId'],operation['candidateId'],operation['contentHash'],operation['decision'],capture_id,json.dumps(snapshot,ensure_ascii=False,sort_keys=True,separators=(',',':'))));database.commit();proof=None
                    if proof is None:
                        file_hash='none'
                        if operation['decision']=='approved':
                            dirs=snapshot_schema.ensure_sources_dirs(vault_root);candidate_target=dirs['approved']/snapshot_schema._safe_filename(capture_id)
                            if candidate_target.exists() and json.loads(candidate_target.read_text(encoding='utf-8')).get('captureId')!=capture_id:raise ValueError('capture-filename-conflict')
                            target=snapshot_schema.write_approved_snapshot(vault_root,snapshot);readback=snapshot_schema.read_approved_snapshot(vault_root,target.name)
                            if readback!=snapshot:raise ValueError('capture-readback-conflict')
                            file_hash=hashlib.sha256(target.read_bytes()).hexdigest();capture_store.mark_processed(database,capture_id);_remove_capture_pending(vault_root,capture_id)
                        elif operation['decision']=='rejected':
                            dirs=snapshot_schema.ensure_sources_dirs(vault_root);target=dirs['rejected']/snapshot_schema._safe_filename(capture_id)
                            if target.exists() and json.loads(target.read_text(encoding='utf-8')).get('captureId')!=capture_id:raise ValueError('capture-filename-conflict')
                            payload=(json.dumps(snapshot,ensure_ascii=False,indent=2)+'\n').encode('utf-8');tmp=target.with_suffix('.json.tmp');tmp.write_bytes(payload);os.replace(tmp,target)
                            if json.loads(target.read_text(encoding='utf-8'))!=snapshot:raise ValueError('capture-readback-conflict')
                            file_hash=hashlib.sha256(target.read_bytes()).hexdigest();capture_store.mark_processed(database,capture_id);_remove_capture_pending(vault_root,capture_id)
                        proof=account_study_hash({'candidateId':operation['candidateId'],'contentHash':operation['contentHash'],'decision':operation['decision'],'snapshot':snapshot,'fileHash':file_hash})
                        database.execute("UPDATE account_content_decision_jobs SET status='complete',proof_hash=? WHERE operation_id=? AND status='pending'",(proof,operation['operationId']));database.execute('INSERT INTO account_content_decision_log VALUES(?,?,?,?,?)',(operation['operationId'],operation['candidateId'],operation['contentHash'],operation['decision'],proof));database.commit()
                    results.append({'schemaVersion':1,'receiptId':'content-receipt:'+account_study_hash([operation['operationId'],proof]),'operationId':operation['operationId'],'candidateId':operation['candidateId'],'contentHash':operation['contentHash'],'decision':operation['decision'],'status':'applied','proofHash':proof});continue
                log=change_detect.decision_log(database,operation['candidateId'])
                if candidate and candidate.get('contentHash')==operation['contentHash']:
                    if not log or log[-1]['decision']!=operation['decision']:change_detect.decide_candidate(database,candidate,operation['decision'],owner,vault_root)
                    log=change_detect.decision_log(database,operation['candidateId'])
                elif not log or log[-1]['decision']!=operation['decision']:raise ValueError('source-change-stale')
                proof=account_study_hash(log)
                database.execute('INSERT INTO account_content_decision_log VALUES(?,?,?,?,?)',(operation['operationId'],operation['candidateId'],operation['contentHash'],operation['decision'],proof));database.commit()
                results.append({'schemaVersion':1,'receiptId':'content-receipt:'+account_study_hash([operation['operationId'],proof]),'operationId':operation['operationId'],'candidateId':operation['candidateId'],'contentHash':operation['contentHash'],'decision':operation['decision'],'status':'applied','proofHash':proof})
            except (ValueError,OSError):
                results.append({'schemaVersion':1,'receiptId':'content-receipt:'+account_study_hash([operation['operationId'],'blocked']),'operationId':operation['operationId'],'candidateId':operation['candidateId'],'contentHash':operation['contentHash'],'decision':operation['decision'],'status':'blocked','reason':'source-change-stale'})
    return results


@contextmanager
def local_database() -> Iterator[sqlite3.Connection]:
    LOCAL_DATABASE_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(LOCAL_DATABASE_PATH, timeout=10)
    try:
        connection.execute("PRAGMA journal_mode=WAL")
        connection.execute("PRAGMA foreign_keys=ON")
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS installation_owner (
              singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
              user_hash TEXT NOT NULL UNIQUE,
              created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS installation_metadata (
              key TEXT PRIMARY KEY,
              value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS companion_sessions (
              token_hash TEXT PRIMARY KEY,
              user_hash TEXT NOT NULL,
              created_at TEXT NOT NULL,
              last_seen_at TEXT NOT NULL,
              expires_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS local_activity_events (
              user_hash TEXT NOT NULL,
              event_id TEXT NOT NULL,
              payload_json TEXT NOT NULL,
              created_at TEXT NOT NULL,
              PRIMARY KEY (user_hash, event_id)
            );
            CREATE INDEX IF NOT EXISTS idx_local_activity_user_created
            ON local_activity_events(user_hash, created_at);
            """
        )
        ensure_study_v3_schema(connection)
        session_columns = {row[1] for row in connection.execute("PRAGMA table_info(companion_sessions)")}
        if "expires_at" not in session_columns:
            connection.execute("ALTER TABLE companion_sessions ADD COLUMN expires_at TEXT")
            connection.execute(
                "UPDATE companion_sessions SET expires_at = ? WHERE expires_at IS NULL",
                ((datetime.now(LOCAL_TZ) + timedelta(days=SESSION_TTL_DAYS)).isoformat(timespec="seconds"),),
            )
        yield connection
        connection.commit()
    finally:
        connection.close()


def pair_account(code: str, raw_user_id: str) -> dict[str, str]:
    global PAIRING_CODE, PAIRING_FAILURES
    normalized_user_id = raw_user_id.strip()
    if len(normalized_user_id) < 4 or len(normalized_user_id) > 256:
        raise ValueError("登录身份无效。")
    with PAIRING_LOCK:
        if not hmac.compare_digest(code.strip().upper(), PAIRING_CODE):
            PAIRING_FAILURES += 1
            if PAIRING_FAILURES >= 5:
                PAIRING_CODE = secrets.token_hex(3).upper()
                PAIRING_FAILURES = 0
                print(f"配对失败次数过多，新的知学一次性配对码：{PAIRING_CODE}")
                raise ValueError("连续失败次数过多，旧配对码已作废；请查看 Companion 窗口中的新代码。")
            raise ValueError(f"配对码无效；还可尝试 {5 - PAIRING_FAILURES} 次。")
        now_value = datetime.now(LOCAL_TZ)
        now = now_value.isoformat(timespec="seconds")
        expires_at = (now_value + timedelta(days=SESSION_TTL_DAYS)).isoformat(timespec="seconds")
        session_token = secrets.token_urlsafe(32)
        with local_database() as database:
            hashed_user = installation_user_hash(database, normalized_user_id)
            owner = database.execute("SELECT user_hash FROM installation_owner WHERE singleton = 1").fetchone()
            if owner and owner[0] != hashed_user:
                raise ValueError("这份 Companion 已绑定另一账号；请为当前账号使用独立安装目录。")
            database.execute(
                "INSERT OR IGNORE INTO installation_owner(singleton, user_hash, created_at) VALUES (1, ?, ?)",
                (hashed_user, now),
            )
            database.execute(
                "INSERT INTO companion_sessions(token_hash, user_hash, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)",
                (token_hash(session_token), hashed_user, now, now, expires_at),
            )
        PAIRING_CODE = secrets.token_hex(3).upper()
        PAIRING_FAILURES = 0
        print(f"新的知学一次性配对码：{PAIRING_CODE}")
        return {"sessionToken": session_token, "accountLabel": f"本机账号 {hashed_user[:8]}"}


def authenticate_session(token: str | None) -> str | None:
    if not token:
        return None
    hashed_token = token_hash(token)
    with local_database() as database:
        row = database.execute(
            "SELECT user_hash, expires_at FROM companion_sessions WHERE token_hash = ?",
            (hashed_token,),
        ).fetchone()
        if not row:
            return None
        if datetime.fromisoformat(str(row[1])) <= datetime.now(LOCAL_TZ):
            database.execute("DELETE FROM companion_sessions WHERE token_hash = ?", (hashed_token,))
            return None
        database.execute(
            "UPDATE companion_sessions SET last_seen_at = ? WHERE token_hash = ?",
            (datetime.now(LOCAL_TZ).isoformat(timespec="seconds"), hashed_token),
        )
        return str(row[0])


def revoke_session(token: str | None) -> bool:
    if not token:
        return False
    with local_database() as database:
        cursor = database.execute("DELETE FROM companion_sessions WHERE token_hash = ?", (token_hash(token),))
        return cursor.rowcount > 0


def store_local_activity(hashed_user: str, payload: dict[str, Any]) -> None:
    event_id = str(payload.get("eventId", ""))
    with local_database() as database:
        database.execute(
            "INSERT OR IGNORE INTO local_activity_events(user_hash, event_id, payload_json, created_at) VALUES (?, ?, ?, ?)",
            (hashed_user, event_id, json.dumps(payload, ensure_ascii=False), datetime.now(LOCAL_TZ).isoformat(timespec="seconds")),
        )


def source_path(key: str) -> Path:
    value = CONFIG.get(key, "")
    if not str(value).strip():
        return ROOT / "__not_configured__"
    return Path(os.path.expandvars(os.path.expanduser(value)))


def learning_vault_path(relative: str = "") -> Path:
    root = source_path("learning_vault_root").resolve()
    candidate = (root / relative).resolve()
    if candidate != root and root not in candidate.parents:
        raise ValueError("路径超出已授权的 Obsidian Vault。")
    return candidate


def parse_frontmatter_scalar(raw: str) -> Any:
    from infrastructure.vault_documents import parse_frontmatter_scalar as execute
    return execute(raw)


def read_frontmatter(path: Path) -> tuple[dict[str, Any], str]:
    from infrastructure.vault_documents import read_frontmatter as execute
    return execute(path)


def note_title(path: Path, body: str) -> str:
    from infrastructure.vault_documents import note_title as execute
    return execute(path, body)


def safe_date(value: Any) -> date | None:
    from infrastructure.vault_documents import safe_date as execute
    return execute(value)


def relative_note_path(path: Path) -> str:
    return path.relative_to(learning_vault_path()).as_posix()


def integration_root() -> Path:
    relative = str(CONFIG.get("study_loop_integration_root", "_System/Integrations/Study Loop"))
    return learning_vault_path(relative)


def event_log_path(day: date) -> Path:
    return integration_root() / "events" / str(day.year) / f"{day.isoformat()}.jsonl"


def read_activity_events(day: date) -> list[dict[str, Any]]:
    from infrastructure.dashboard_reader import read_activity_events as execute
    return execute(day, event_log_path=event_log_path)


def dashboard_activity_events(day: date) -> list[dict[str, Any]]:
    from infrastructure.dashboard_reader import dashboard_activity_events as execute
    return execute(day, learning_vault_path=learning_vault_path, read_activity_events=read_activity_events)


def active_project_stages() -> list[dict[str, Any]]:
    from infrastructure.dashboard_reader import active_project_stages as execute
    return execute(learning_vault_path=learning_vault_path, read_frontmatter=read_frontmatter, relative_note_path=relative_note_path)


def active_research_sessions() -> list[dict[str, Any]]:
    from infrastructure.dashboard_reader import active_research_sessions as execute
    return execute(learning_vault_path=learning_vault_path, read_frontmatter=read_frontmatter, relative_note_path=relative_note_path)


def due_review_items(today: date) -> list[dict[str, Any]]:
    from infrastructure.dashboard_reader import due_review_items as execute
    return execute(today, learning_vault_path=learning_vault_path, read_frontmatter=read_frontmatter, relative_note_path=relative_note_path)


def daily_dashboard(day: date | None = None) -> dict[str, Any]:
    from infrastructure.dashboard_reader import daily_dashboard as execute
    return execute(day, indexed_study_payload=indexed_study_payload, source_path=source_path, learning_vault_path=learning_vault_path, read_frontmatter=read_frontmatter, due_review_items=due_review_items, dashboard_activity_events=dashboard_activity_events, relative_note_path=relative_note_path, active_project_stages=active_project_stages, active_research_sessions=active_research_sessions, now=lambda: datetime.now(LOCAL_TZ))


def clean_markdown_cell(value: Any, limit: int = 180) -> str:
    from application.activity_values import clean_markdown_cell as normalize
    return normalize(value, limit)


def render_daily_report(day: date, events: list[dict[str, Any]]) -> Path:
    from infrastructure.daily_report import render_daily_report as execute
    return execute(day, events, learning_vault_path=learning_vault_path, now=lambda: datetime.now(LOCAL_TZ))


def accept_activity(payload: dict[str, Any], write_to_vault: bool = True) -> dict[str, Any]:
    from infrastructure.legacy_activity_writer import accept_activity as execute
    return execute(payload, write_to_vault, EVENT_ID_PATTERN=EVENT_ID_PATTERN, EVENT_DOMAINS=EVENT_DOMAINS, EVENT_OUTCOMES=EVENT_OUTCOMES, LOCAL_TZ=LOCAL_TZ, DATA_LOCK=DATA_LOCK, learning_vault_path=learning_vault_path, daily_dashboard=daily_dashboard, event_log_path=event_log_path, read_activity_events=read_activity_events, render_daily_report=render_daily_report, dashboard_activity_events=dashboard_activity_events, relative_note_path=relative_note_path, now=lambda: datetime.now(LOCAL_TZ))


def _validate_local_context(local_context: Any, vault_root: Path) -> dict[str, Any]:
    from infrastructure.native_common import _validate_local_context as validate
    return validate(local_context, vault_root)


def _events_for_state(database: sqlite3.Connection, account_id: str, state_ref: str) -> dict[str, list[dict[str, Any]]]:
    from infrastructure.native_common import _events_for_state as read
    return read(database, account_id, state_ref)


def _restore_bytes(path: Path, previous: bytes | None) -> None:
    from infrastructure.native_common import _restore_bytes as restore
    restore(path, previous)


def _native_writer():
    from infrastructure.native_writer import NativeStudyWriter, NativeWritePorts
    from infrastructure.course_event_proof import native_course_event_guard
    return NativeStudyWriter(NativeWritePorts(
        now=lambda: datetime.now(LOCAL_TZ), local_tz=LOCAL_TZ, lock=DATA_LOCK,
        gateway=effective_gateway, dashboard=daily_dashboard, log_path=event_log_path,
        vault_path=learning_vault_path, read_activity=read_activity_events,
        render_report=render_daily_report, report_events=dashboard_activity_events,
        relative_path=relative_note_path,
        course_guard=lambda db, root, owner, event, catalog: native_course_event_guard(db, root, owner, event, catalog, catalog_loader=effective_gateway, store_path=LOCAL_DATABASE_PATH),
    ))


def accept_study_event_v3(database: sqlite3.Connection, vault_root: Path, account_id: str, payload: dict[str, Any], write_to_vault: bool = True) -> dict[str, Any]:
    return _native_writer().accept(database, vault_root, account_id, payload, write_to_vault)


def indexed_study_payload(vault_root: Path, account_id: str | None, *, refresh: bool = False, day: date | None = None) -> dict[str, Any] | None:
    from infrastructure.study_pool import indexed_study_payload as execute
    return execute(vault_root, account_id, refresh=refresh, day=day, effective_gateway=effective_gateway, validate_study_event_v3=validate_study_event_v3, LOCAL_TZ=LOCAL_TZ, read_frontmatter=read_frontmatter, now=lambda: datetime.now(LOCAL_TZ))


def accept_assistance_payload(account_id, payload):
    from account_sync_schema import study_object
    from assistance_schema import validate_native_assistance
    study_object(payload,['record']);record=validate_native_assistance(payload['record']);event_id=record['summary']['attemptEventId']
    with local_database() as db:
        row=db.execute('SELECT e.event_json,b.binding_json,p.status FROM study_events_v3 e LEFT JOIN study_event_bindings b ON b.account_id=e.account_id AND b.event_id=e.event_id LEFT JOIN study_event_projections p ON p.account_id=e.account_id AND p.event_id=e.event_id WHERE e.account_id=? AND e.event_id=?',(account_id,event_id)).fetchone()
        if not row: raise ValueError('assistance-parent-pending')
        if row[2] not in (None,'applied'): raise ValueError('assistance-parent-pending')
        event=validate_study_event_v3(json.loads(row[0]));route=json.loads(row[1]) if row[1] else {'binding':None,'assistanceBindingIssue':'baseline-unverified'}
    return assistance_sync.receive_native(account_id,source_path('learning_vault_root'),LOCAL_DATABASE_PATH.with_name('assistance-study.db'),record,event,route)


def resume_native_assistance_once():
    identity=account_sync_service._installation_identity(LOCAL_DATABASE_PATH)
    path=LOCAL_DATABASE_PATH.with_name('assistance-study.db')
    if identity is None or not path.is_file(): return
    owner=identity[0];inbox=assistance_sync.AssistanceInbox(path);writer=assistance_sync.AssistanceVaultWriter(source_path('learning_vault_root'),owner,path)
    assistance_sync.process_pending(owner,'native',inbox,lambda row:writer.apply_native(row['record'],row['parent'],row['route']),channel='local')


def native_assistance_loop(stop_event):
    while not stop_event.is_set():
        try: resume_native_assistance_once()
        except (ValueError,OSError,sqlite3.Error): pass
        if stop_event.wait(20): break


def accept_indexed_event(database, vault_root, account_id, event, context_raw, catalog, frozen, write_to_vault=True, attempt_binding=None):
    from infrastructure.indexed_writer import IndexedStudyWriter
    return IndexedStudyWriter(lambda: datetime.now(LOCAL_TZ)).accept(database, vault_root, account_id, event, context_raw, catalog, frozen, write_to_vault, attempt_binding)


def _accept_indexed_event_locked(database, vault_root, account_id, event, context_raw, catalog, frozen, write_to_vault=True, attempt_binding=None):
    from infrastructure.indexed_writer import IndexedStudyWriter
    return IndexedStudyWriter(lambda: datetime.now(LOCAL_TZ))._accept_locked(database, vault_root, account_id, event, context_raw, catalog, frozen, write_to_vault, attempt_binding)


def paper_library_request(owner, action, payload=None, query=''):
    import paper_library
    import academic_vocabulary
    if owner != installation_owner_hash(): raise ValueError('paper-owner-mismatch')
    with NOTE_SOURCE_LOCK:
        vault=source_path('learning_vault_root')
        service=paper_library.PaperLibrary(vault,LOCAL_DATABASE_PATH.with_name('paper-library.db'),owner,local_vault_library_id(vault),
            get_note_source_runtime().service,academic_vocabulary.account_library_for_root(LOCAL_DATABASE_PATH.with_name('account-study.db'),owner,vault))
        if action=='catalog': return service.catalog(query)
        if not isinstance(payload,dict): raise ValueError('paper-invalid-input')
        if action=='read':
            service._scope(payload)
            return service.read(payload.get('source'))
        if action=='material': return service.material(payload)
        if action=='figure': return service.figure(payload)
        if action=='save': return service.save(payload)
        raise ValueError('paper-invalid-request')

def paper_vocabulary_request(owner, source=None, payload=None):
    import academic_vocabulary
    if owner != installation_owner_hash(): raise ValueError('vocabulary-installation-owner-mismatch')
    with NOTE_SOURCE_LOCK:
        vault = source_path('learning_vault_root')
        library = local_vault_library_id(vault)
        account = academic_vocabulary.account_library_for_root(LOCAL_DATABASE_PATH.with_name('account-study.db'), owner, vault)
        writer = academic_vocabulary.VocabularyWriter(vault, LOCAL_DATABASE_PATH.with_name('vocabulary-ingestion.db'), owner, library,
            lambda: effective_gateway(vault, owner=owner), account)
        return writer.append(payload) if payload is not None else writer.target(source)

def effective_gateway(vault_root, refresh=False, owner=None):
    import mapped_source_registry
    actual = installation_owner_hash()
    if owner is not None and owner != actual: raise ValueError('mapping-owner-required')
    indexes,entry = (get_note_source_runtime().service.catalog_refs(actual)
        if actual and LOCAL_DATABASE_PATH.with_name('note-sources.db').exists() else ([],None))
    return mapped_source_registry.load_catalog(vault_root, LOCAL_DATABASE_PATH.with_name('vault-mappings.db'), actual, refresh=refresh,extra_indexes=indexes,extra_entry_ref=entry)


def get_note_source_runtime():
    global NOTE_SOURCE_RUNTIME
    with NOTE_SOURCE_LOCK:
        if NOTE_SOURCE_RUNTIME is None or NOTE_SOURCE_RUNTIME.service.data!=LOCAL_DATABASE_PATH.parent:
            import keyring
            service=external_sources.ExternalSources(LOCAL_DATABASE_PATH.parent,lambda:source_path('learning_vault_root'),keyring,
                verify_owner=lambda owner:owner==installation_owner_hash())
            NOTE_SOURCE_RUNTIME=note_source_runtime.SourceRuntime(service,validate_study_event_v3)
        return NOTE_SOURCE_RUNTIME


def note_source_loop(stop):
    while not stop.wait(30):
        if not LOCAL_DATABASE_PATH.with_name('note-sources.db').exists():continue
        try:
            owner=installation_owner_hash()
            if owner:get_note_source_runtime().tick(owner)
        except (ValueError,OSError,sqlite3.Error):
            continue


def runtime_instance_id():
    try:return json.loads((ROOT/'data/runtime-instance.json').read_text(encoding='utf-8'))['instanceId']
    except (OSError,ValueError,KeyError):return None


def mapped_study_payload(payload, vault_root):
    catalog = effective_gateway(vault_root)
    existing = {subject['id'] for subject in payload.get('subjects', [])}
    mapped = [subject for subject in catalog['subjects'] if subject['id'].startswith('mapped:') and subject['items'] and subject['id'] not in existing]
    return {**payload, 'subjects': [*payload.get('subjects', []), *mapped],
            'mappingDiagnostics': catalog.get('mappingDiagnostics', [])}


def vault_mapping_request(owner, payload=None):
    root = source_path('learning_vault_root')
    if not root.is_dir(): raise ValueError('vault-root-unavailable')
    if owner != installation_owner_hash(): raise ValueError('mapping-owner-required')
    database = LOCAL_DATABASE_PATH.with_name('vault-mappings.db')
    current = vault_topology.load(database, root, owner)
    if payload is None: return {**current, **vault_topology.inspect(root)}
    if not isinstance(payload, dict) or set(payload) - {'action', 'rules', 'revision'}: raise ValueError('invalid-mapping-request')
    rules = vault_topology.validate(payload.get('rules'))
    if payload.get('action') == 'preview':
        diagnostics = []
        items = vault_topology.extract(root, rules, diagnostics=diagnostics)
        return {'revision': current['revision'], 'itemCount': len(items), 'items': items[:20], 'diagnostics': diagnostics}
    if payload.get('action') == 'confirm':
        saved = vault_topology.save(database, root, owner, rules, payload.get('revision'))
        catalog = effective_gateway(root, owner=owner)
        return {**saved, 'diagnostics': catalog.get('mappingDiagnostics', [])}
    raise ValueError('invalid-mapping-action')


def merge_source_area(
    payload: dict[str, Any],
    vault_root: Path,
    approved_documents: list[dict[str, str]] | None = None,
) -> dict[str, Any]:
    from infrastructure.study_pool import merge_source_area as execute
    return execute(payload, vault_root, approved_documents, mapped_study_payload=mapped_study_payload)


def normalize_question_subjects(payload: dict[str, Any]) -> dict[str, Any]:
    from application.subject_normalization import normalize_question_subjects as execute
    return execute(payload)


def merge_approved_snapshots(payload: dict[str, Any], vault_root: Path) -> dict[str, Any]:
    from infrastructure.study_pool import merge_approved_snapshots as execute
    return execute(payload, vault_root)


def attach_state_handles(payload: dict[str, Any], account_id: str) -> dict[str, Any]:
    from infrastructure.study_pool import attach_state_handles as execute
    return execute(payload, account_id, local_database=local_database)


def study_event_stats_payload(database: sqlite3.Connection, account_id: str) -> dict[str, Any]:
    from infrastructure.native_common import study_event_stats_payload as diagnostics
    return diagnostics(database, account_id)


def extract_text(path: Path, page_limit: int = 8) -> str:
    from infrastructure.vault_documents import extract_text as execute
    return execute(path, page_limit, selected_pages=lambda: CONFIG.get('pdf_pages'))


def validate_cards(payload: dict[str, Any], title: str, scope: str) -> dict[str, Any]:
    from application.generated_content import validate_cards as normalize
    from learning_support import has_executable_code_material
    return normalize(payload, title, scope, seed=SEED, stamp=time.strftime,
                     code_material_available=has_executable_code_material)



def _legacy_ai():
    from infrastructure.legacy_ai import LegacyLearningProvider, LegacyModelPorts
    return LegacyLearningProvider(LegacyModelPorts(
        key=lambda: deepseek_key(), model=lambda default: CONFIG.get('deepseek_model', default),
        default_model=lambda: CURRENT_MODEL_DEFAULT,
        open=lambda *args, **kwargs: open_deepseek(*args, **kwargs),
        validate=lambda *args: validate_cards(*args),
    ))


def suggestion_ai(messages):
    return _legacy_ai().suggestion_ai(messages)


def reorder_plan_with_deepseek(items):
    return _legacy_ai().reorder_plan_with_deepseek(items)


def get_hint_deepseek(question, wrong_answer):
    return _legacy_ai().get_hint_deepseek(question, wrong_answer)


def grade_recall_deepseek(item: dict[str, Any], answer: Any) -> dict[str, Any]:
    return _legacy_ai().grade_recall_deepseek(item, answer)

def correct_card_deepseek(card, instruction):
    return _legacy_ai().correct_card_deepseek(card, instruction)

def call_deepseek(current_text: str, next_text: str, title: str, scope: str) -> dict[str, Any]:
    return _legacy_ai().call_deepseek(current_text, next_text, title, scope)


def refresh_from_config() -> dict[str, Any]:
    indexed = indexed_study_payload(source_path("learning_vault_root"), None, refresh=True)
    if indexed is not None:
        return indexed
    current = resolve_current_source()
    next_source = source_path("next_source")
    current_text = extract_text(current)
    next_text = extract_text(next_source, page_limit=2) if next_source.exists() else ""
    configured_title = str(CONFIG.get("current_title", "")).strip()
    title = current.stem if not configured_title or configured_title == "我的当前学习资料" else configured_title
    return call_deepseek(
        current_text,
        next_text,
        title,
        CONFIG.get("reading_scope", "当前学习材料"),
    )


def set_state(value: dict[str, Any]) -> None:
    global STATE
    with DATA_LOCK:
        STATE = value


def supported_note_files(root: Path) -> list[Path]:
    from infrastructure.vault_documents import supported_note_files as execute
    return execute(root, SUPPORTED_NOTE_SUFFIXES=SUPPORTED_NOTE_SUFFIXES)


def resolve_current_source() -> Path:
    configured = source_path("current_source")
    if configured.exists() and configured.is_file():
        return configured
    candidates: list[Path] = []
    for key in ("local_notes_root", "learning_vault_root"):
        root = source_path(key)
        files = supported_note_files(root)
        if key == "learning_vault_root":
            session_root = (root / learning_session.SESSION_ROOT).resolve()
            files = [path for path in files if session_root not in path.resolve().parents]
        candidates.extend(files)
    if not candidates:
        raise FileNotFoundError("尚未配置可读取的学习文件、Obsidian Vault 或本地笔记目录。")
    return max(candidates, key=lambda path: path.stat().st_mtime)


def count_supported(root: Path, subfolders: list[str] | None = None) -> int:
    if not root.exists():
        return 0
    folders = [root / name for name in subfolders] if subfolders else [root]
    return sum(len(supported_note_files(folder)) for folder in folders if folder.exists())


def connection_state() -> list[dict[str, Any]]:
    learning_root = source_path("learning_vault_root")
    indexed = indexed_study_payload(learning_root, None)
    if indexed is not None:
        return indexed["connections"]
    local_notes_root = source_path("local_notes_root")
    knowledge_root = source_path("knowledge_base_root")
    deepseek_ready = bool(deepseek_key())
    with DATA_LOCK:
        provider_unavailable = STATE.get("status") == "provider_unavailable"
    return [
        {
            "key": "obsidian",
            "label": "Obsidian 学习库",
            "status": "ready" if learning_root.exists() else "offline",
            "detail": "当前论文、下一篇材料与学习笔记" if learning_root.exists() else "未找到已授权的学习库",
            "count": count_supported(learning_root),
        },
        {
            "key": "localnotes",
            "label": "本地笔记目录",
            "status": "ready" if local_notes_root.exists() else "offline",
            "detail": "读取已授权目录中的 Markdown、TXT 与 PDF" if local_notes_root.exists() else "尚未配置普通笔记目录",
            "count": count_supported(local_notes_root),
        },
        {
            "key": "knowledge",
            "label": "AI Knowledge Base",
            "status": "ready" if knowledge_root.exists() else "offline",
            "detail": "仅读取 Memory、Projects 与 Workflows 正式记录" if knowledge_root.exists() else "未找到知识库",
            "count": count_supported(knowledge_root, ["Memory", "Projects", "Workflows"]),
        },
        {
            "key": "companion",
            "label": "本地同步助手",
            "status": "connected",
            "detail": "读取权威进度；网站结果仅追加为学习事件",
        },
        {
            "key": "deepseek",
            "label": "OpenAI API" if ai_settings()["provider"] == "chatgpt" else "DeepSeek API",
            "status": "offline" if provider_unavailable else "connected" if deepseek_ready else "missing",
            "detail": "网络暂时不可达，Companion 仍在线" if provider_unavailable else "可生成词卡与明日预热" if deepseek_ready else "等待本地 API 密钥",
        },
    ]


def with_connections(payload: dict[str, Any]) -> dict[str, Any]:
    indexed = indexed_study_payload(source_path("learning_vault_root"), None)
    if indexed is not None:
        return indexed
    return {**payload, "connections": connection_state(), "dashboard": daily_dashboard()}


def safe_refresh() -> None:
    indexed = indexed_study_payload(source_path("learning_vault_root"), None, refresh=True)
    if indexed is not None:
        set_state(indexed)
        return
    if not deepseek_key():
        set_state({**SEED, "status": "key_missing", "message": "已同步来源，等待当前 AI 提供商的本地 API 配置。"})
        return
    try:
        set_state(refresh_from_config())
    except DeepSeekUnavailableError as error:
        # Keep the last good learning pool visible.  A provider outage is not
        # a Companion disconnect and must not replace personal data with seed
        # content or expose a raw WinError/URLError in the web UI.
        with DATA_LOCK:
            previous = dict(STATE)
        set_state({
            **previous,
            "status": "provider_unavailable",
            "message": f"Companion 已连接，但{error}",
        })
    except Exception as error:
        set_state({**SEED, "status": "error", "message": str(error)})


def run_change_scan_once() -> dict[str, Any]:
    global CHANGE_SCAN_STATUS
    vault_root = source_path("learning_vault_root")
    indexed = indexed_study_payload(vault_root, None, refresh=True)
    if indexed is not None:
        CHANGE_SCAN_STATUS = {"scannedAt": indexed["syncedAt"], "pendingCount": 0, "error": None, "mode": "indexed", "diagnostics": indexed["gateway"]["diagnostics"]}
        return dict(CHANGE_SCAN_STATUS)
    if not vault_root.exists():
        CHANGE_SCAN_STATUS = {"scannedAt": None, "pendingCount": 0, "error": "vault-not-configured"}
        return dict(CHANGE_SCAN_STATUS)
    with local_database() as database:
        status = change_detect.scan_and_project(database, vault_root)
    CHANGE_SCAN_STATUS = status.to_payload()
    return dict(CHANGE_SCAN_STATUS)


def change_scan_loop(stop_event: threading.Event, interval_seconds: int = 900) -> None:
    interval = max(60, int(interval_seconds))
    while not stop_event.is_set():
        run_change_scan_once()
        if stop_event.wait(interval):
            return


def start_change_scanner(
    stop_event: threading.Event | None = None,
    interval_seconds: int | None = None,
) -> tuple[threading.Event, threading.Thread]:
    stop = stop_event or threading.Event()
    configured = int(os.getenv("ZHIXUE_CHANGE_SCAN_SECONDS", CONFIG.get("change_scan_seconds", 900))) if interval_seconds is None else interval_seconds
    thread = threading.Thread(target=change_scan_loop, args=(stop, configured), daemon=True, name="zhixue-change-scan")
    thread.start()
    return stop, thread


def _constraint_history(database: sqlite3.Connection, account_id: str) -> list[dict[str, Any]]:
    ensure_study_v3_schema(database)
    rows = database.execute(
        "SELECT event_json, local_context_json FROM study_events_v3 WHERE account_id = ? ORDER BY occurred_at, event_id",
        (account_id,),
    ).fetchall()
    events: list[dict[str, Any]] = []
    for event_json, context_json in rows:
        try:
            event = json.loads(event_json)
            context = json.loads(context_json) if context_json else {}
        except json.JSONDecodeError:
            continue
        if isinstance(event, dict):
            if isinstance(context, dict):
                event["localContext"] = context
                if isinstance(context.get("durationMin"), int):
                    event["durationMin"] = context["durationMin"]
            events.append(event)
    return events


def effective_constraints(vault_root: Path, account_id: str, now: datetime | None = None) -> dict[str, Any]:
    with constraint_area.CONSTRAINT_LOCK:
        now = now or datetime.now(UTC)
        document = constraint_area.read_constraints(vault_root, now)
        with local_database() as database:
            events = _constraint_history(database, account_id)
        approved_plans = [
            row["after"]
            for row in plan_area.read_revisions(plan_area.plan_area_root(vault_root))
            if row.get("decision", "applied") != "rejected" and isinstance(row.get("after"), dict)
        ]
        estimate = history_estimator.estimate_schedule(events, approved_plans, document.get("deadlines", []), study_day(now))
        document["system"] = {
            "dailyMinutes": {"min": estimate.minimum_minutes, "max": estimate.maximum_minutes},
            "weeklyRhythm": estimate.weekly_rhythm,
            "loadFactor": estimate.load_factor,
            "minimumReviewMinutes": estimate.minimum_review_minutes,
        }
        document["estimatedAt"] = now.astimezone(UTC).isoformat(timespec="seconds")
        document["explanation"] = estimate.explanation
        if document.get("mode") == "temporary" and not constraint_area._temporary_active(document, now):
            document["mode"] = "auto"
            document["override"] = None
            document["temporaryUntil"] = None
        constraint_area.write_constraints(vault_root, document, now)
        return constraint_area.read_constraints(vault_root, now)


def watch_loop() -> None:
    global LAST_SIGNATURE
    while True:
        if (source_path("learning_vault_root") / index_gateway.GATEWAY_ROOT).exists():
            safe_refresh()
            time.sleep(60)
            continue
        try:
            current = resolve_current_source()
        except FileNotFoundError:
            current = source_path("current_source")
        paths = [current, source_path("next_source")]
        signature = tuple(f"{path.resolve()}:{path.stat().st_mtime if path.exists() else 0}" for path in paths)
        if signature != LAST_SIGNATURE:
            LAST_SIGNATURE = signature
            safe_refresh()
        configured_interval = int(CONFIG.get("auto_sync_seconds", CONFIG.get("poll_seconds", 86400)))
        time.sleep(max(86400, configured_interval))


def allowed_origin(origin: str | None) -> str | None:
    if not origin:
        return None
    allowed = CONFIG.get("allowed_origins", ["https://zhixue-daily.zthagyamin.chatgpt.site"])
    return origin if origin in allowed else None


def normalize_request_path(raw_path: str) -> str:
    """Normalize proxy-style, duplicated, and trailing slashes for local routes."""
    if "://" in raw_path:
        path = urllib.parse.urlsplit(raw_path).path
    else:
        path = raw_path.split("?", 1)[0].split("#", 1)[0]
    return "/" + "/".join(part for part in path.split("/") if part)


def route_services() -> RouteServices:
    """Bind live services per request; background refresh may replace STATE."""
    return RouteServices(
        CONFIG=CONFIG,
        DATA_LOCK=DATA_LOCK,
        LOCAL_DATABASE_PATH=LOCAL_DATABASE_PATH,
        LOCAL_TZ=LOCAL_TZ,
        NOTE_SOURCE_LOCK=NOTE_SOURCE_LOCK,
        ROOT=ROOT,
        STUDY_V3_SCHEMA_VERSION=STUDY_V3_SCHEMA_VERSION,
        accept_activity=accept_activity,
        accept_assistance_payload=accept_assistance_payload,
        accept_study_event_v3=accept_study_event_v3,
        ai_store=ai_store,
        allowed_origin=allowed_origin,
        attach_state_handles=attach_state_handles,
        call_deepseek=call_deepseek,
        correct_card_deepseek=correct_card_deepseek,
        daily_dashboard=daily_dashboard,
        deepseek_key=deepseek_key,
        due_review_items=due_review_items,
        effective_constraints=effective_constraints,
        effective_gateway=effective_gateway,
        get_account_sync_service=get_account_sync_service,
        get_hint_deepseek=get_hint_deepseek,
        get_note_source_runtime=get_note_source_runtime,
        grade_recall_deepseek=grade_recall_deepseek,
        indexed_study_payload=indexed_study_payload,
        installation_owner_hash=installation_owner_hash,
        local_database=local_database,
        local_vault_library_id=local_vault_library_id,
        merge_source_area=merge_source_area,
        normalize_question_subjects=normalize_question_subjects,
        paper_library_request=paper_library_request,
        paper_vocabulary_request=paper_vocabulary_request,
        reorder_plan_with_deepseek=reorder_plan_with_deepseek,
        revoke_session=revoke_session,
        run_change_scan_once=run_change_scan_once,
        safe_refresh=safe_refresh,
        save_deepseek_key=save_deepseek_key,
        set_state=set_state,
        source_path=source_path,
        store_local_activity=store_local_activity,
        study_event_stats_payload=study_event_stats_payload,
        suggestion_ai=suggestion_ai,
        validate_study_event_v3=validate_study_event_v3,
        vault_mapping_request=vault_mapping_request,
        with_connections=with_connections,
        read_state=lambda: STATE,
    )


class Handler(BaseHTTPRequestHandler):
    server_version = f"StudyLoopCompanion/{companion_version()}"

    def send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        origin = allowed_origin(self.headers.get("Origin"))
        if origin:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Vary", "Origin")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:
        origin = allowed_origin(self.headers.get("Origin"))
        if not origin:
            self.send_response(403)
            self.end_headers()
            return
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Study-Loop-Session")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Max-Age", "600")
        self.end_headers()

    def do_GET(self) -> None:
        request_path = normalize_request_path(self.path)
        if request_path == "/v1/health":
            self.send_json(200, {"ok": True, "status": STATE.get("status"), "pairingRequired": True, "localDatabase": True, "serverVersion": self.server_version, "instanceId":runtime_instance_id(), "capabilities": [STUDY_DAY_CAPABILITY, task_plan_schema.CAPABILITY, task_plan_schema.POLICY_CAPABILITY, task_plan_schema.PRACTICE_BUDGET_CAPABILITY, account_sync_service.CAPABILITY, assistance_sync.CAPABILITY, "assistance-summary-v2", external_sources.CAPABILITY, "paper-library-v1", "native-course-v1", "native-math-v1", "native-math-variants-v1"]})
            return
        hashed_user = authenticate_session(self.headers.get("X-Study-Loop-Session"))
        if not hashed_user:
            self.send_json(401, {"message": "请先用当前登录账号配对 Companion。"})
            return
        if http_routes.dispatch('GET', request_path, self, route_services(), hashed_user):
            return
        self.send_json(404, {"message": "Not found"})

    def do_POST(self) -> None:
        request_path = normalize_request_path(self.path)
        if not allowed_origin(self.headers.get("Origin")):
            self.send_json(403, {"message": "该网页来源未被本地同步助手授权。"})
            return
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > MAX_UPLOAD_BYTES:
            self.send_json(413, {"message": "文件为空或超过 1.5MB。"})
            return
        try:
            payload = json.loads(self.rfile.read(length).decode("utf-8"))
            if request_path == "/v1/pair":
                result = pair_account(str(payload.get("code", "")), str(payload.get("userId", "")))
                self.send_json(200, {**result, "paired": True})
                return
            hashed_user = authenticate_session(self.headers.get("X-Study-Loop-Session"))
            if not hashed_user:
                self.send_json(401, {"message": "Companion 会话无效，请重新配对。"})
                return
            if http_routes.dispatch('POST', request_path, self, route_services(), hashed_user, payload):
                return
            self.send_json(404, {"message": "Not found"})
        except ValueError as error:
            if str(error) == "stale-plan-revision":
                self.send_json(409, {"status": "stale", "message": "计划已在其他位置更新，请刷新后重试。"})
            else:
                self.send_json(400, {"message": str(error)})
        except Exception as error:
            self.send_json(500, {"message": str(error)})

    def log_message(self, format: str, *args: Any) -> None:
        return


if __name__ == "__main__":
    thread = threading.Thread(target=watch_loop, daemon=True)
    thread.start()
    scan_stop, _scan_thread = start_change_scanner()
    assistance_stop = threading.Event()
    threading.Thread(target=native_assistance_loop,args=(assistance_stop,),daemon=True).start()
    threading.Thread(target=note_source_loop,args=(assistance_stop,),daemon=True).start()
    host = "127.0.0.1"
    port = int(CONFIG.get("port", 43121))
    print(f"知学同步助手已启动：http://{host}:{port}")
    print(f"知学一次性配对码：{PAIRING_CODE}")
    print("资料候选每 15 分钟检查一次；完整内容每天同步一次，也可以随时手动触发。")
    print("只读取 config.local.json 中授权的学习来源；按 Ctrl+C 停止。")
    httpd = ThreadingHTTPServer((host, port), Handler)
    try:
        try:
            get_account_sync_service().resume()
        except Exception:
            print('账号后台同步暂未启动；原有本机学习与配对功能继续可用。')
        httpd.serve_forever()
    finally:
        scan_stop.set()
        assistance_stop.set()
        if ACCOUNT_SYNC_SERVICE is not None:
            ACCOUNT_SYNC_SERVICE.shutdown()
        httpd.server_close()
