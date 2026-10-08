"""Paired setup and lifecycle for account sync, with injectable runtime inputs."""
from __future__ import annotations

import hashlib
import hmac
import sqlite3
import threading
from contextlib import closing
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4
import planning_catalog
import assistance_sync

from account_sync_credentials import LinkStore, trusted_origin
from account_sync_export import capture_catalog, export_catalog
from account_sync_planning import export_planning, rebind_planning_facts
from account_sync_plan_writer import apply_operation, validate_plan_source_bindings
from account_sync_inbox import Inbox
from account_sync_schema import study_digest, study_hash, study_id
from account_sync_worker import BackgroundSync, HttpTransport
from account_sync_writer import VerifiedVaultWriter

CAPABILITY = 'account-study-sync-v1'


def _installation_identity(database_path):
    path = Path(database_path)
    if not path.is_file():
        return None
    try:
        with closing(sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True, timeout=5)) as db:
            db.execute('BEGIN')
            owner = db.execute('SELECT user_hash FROM installation_owner WHERE singleton=1').fetchone()
            salt = db.execute("SELECT value FROM installation_metadata WHERE key='user_hash_salt'").fetchone()
            if not owner or not salt:
                return None
            study_digest(owner[0]); study_digest(salt[0])
            return owner[0], bytes.fromhex(salt[0])
    except (ValueError, sqlite3.Error, OSError):
        return None


def verify_installation_owner(database_path, expected_owner, cloud_user_id=None):
    identity = _installation_identity(database_path)
    if not identity or type(expected_owner) is not str or not hmac.compare_digest(identity[0], expected_owner):
        return False
    if cloud_user_id is None:
        return True
    if type(cloud_user_id) is not str or not 4 <= len(cloud_user_id.strip()) <= 256:
        return False
    actual = hmac.new(identity[1], cloud_user_id.strip().encode('utf-8'), hashlib.sha256).hexdigest()
    return hmac.compare_digest(actual, expected_owner)


class AccountSyncService:
    def __init__(self, data_directory, installation_database, vault_resolver, allowed_origins, credential_provider,
                 *, transport=None, clock=None, interval_seconds=60, planning_provider=None, content_processor=None, catalog_loader=None):
        self.catalog_loader = catalog_loader
        self.path = Path(data_directory) / 'account-study.db'; self.installation_database = Path(installation_database)
        self.vault_resolver = vault_resolver; self.allowed_origins = tuple(allowed_origins)
        self.clock = clock or (lambda: datetime.now(timezone.utc)); self.interval = max(1, interval_seconds);self.planning_provider=planning_provider;self.content_processor=content_processor
        self.links = LinkStore(self.path, credential_provider, allowed_origins=self.allowed_origins)
        self.inbox = Inbox(self.path); self.transport = transport or HttpTransport(self.allowed_origins)
        self.lock = threading.Lock(); self.workers = {}; self.generations = {}; self.closing = False
        with self.inbox._connect(write=True) as db:
            db.execute('''CREATE TABLE IF NOT EXISTS account_sync_libraries(
                owner_id TEXT NOT NULL,library_id TEXT PRIMARY KEY,vault_ref TEXT NOT NULL,metadata_hash TEXT NOT NULL,
                UNIQUE(owner_id,vault_ref))''')

    def _owner(self, owner):
        if not verify_installation_owner(self.installation_database, owner):
            raise ValueError('account-installation-owner-mismatch')

    def _vault(self):
        vault = Path(self.vault_resolver()).resolve()
        if not vault.is_dir():
            raise ValueError('account-learning-vault-unavailable')
        return vault

    def _library(self, owner, library):
        with self.inbox._connect() as db:
            row = db.execute('SELECT * FROM account_sync_libraries WHERE owner_id=? AND library_id=?', (owner, library)).fetchone()
        if not row or row['metadata_hash'] != study_hash([owner, library, row['vault_ref']]):
            raise ValueError('account-library-binding')
        path = Path(row['vault_ref'])
        if path.resolve() != path or path != self._vault():
            raise ValueError('account-learning-vault-changed')
        return path

    def prepare(self, owner, origin, label, rotate=False):
        self._owner(owner); trusted_origin(origin, self.allowed_origins); vault = self._vault()
        with self.inbox._connect(write=True) as db:
            row = db.execute('SELECT library_id FROM account_sync_libraries WHERE owner_id=? AND vault_ref=?', (owner, str(vault))).fetchone()
            if row:
                library = row['library_id']
            else:
                library = str(uuid4())
                db.execute('INSERT INTO account_sync_libraries VALUES(?,?,?,?)', (owner, library, str(vault), study_hash([owner, library, str(vault)])))
        self._library(owner, library)
        prepared = [link for link in self.links.list_links(owner)
                    if link['libraryId'] == library and link['origin'] == origin and link['label'] == label and link['state'] in ('active','paused','prepared')]
        if prepared and not rotate:
            return {key: prepared[-1][key] for key in ('grantId', 'libraryId', 'tokenHash', 'label')}
        return self.links.prepare(owner, library, origin, label)

    def _link(self, owner, grant):
        self._owner(owner); study_id(grant)
        link = next((value for value in self.links.list_links(owner) if value['grantId'] == grant), None)
        if not link:
            raise ValueError('unknown-account-link')
        return link

    def _worker(self, owner, link, stop_event):
        vault = self._library(owner, link['libraryId'])
        loader = (lambda root, refresh=False: self.catalog_loader(root, owner, refresh=refresh)) if self.catalog_loader else None
        writer = VerifiedVaultWriter(vault, owner, self.inbox, self.path, catalog_loader=loader)

        def publisher(head):
            self._owner(owner); self._library(owner, link['libraryId'])
            catalog, identities = capture_catalog(vault, catalog_loader=loader)
            revision = head['revision'] + 1 if head else 1
            captured = self.clock().astimezone(timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z')
            bundle, bindings = export_catalog(catalog, identities, link['libraryId'], str(uuid4()), revision, captured)
            context=self.planning_provider(vault,catalog,owner) if self.planning_provider else None
            if context is not None:
                tasks={}
                for event in [*context.get('legacyTaskEvents',[]),*writer.task_events(link['libraryId'])]:
                    old=tasks.get(event['eventId'])
                    if old and old!=event:raise ValueError('task-event-conflict')
                    tasks[event['eventId']]=event
                context={**context,'legacyTaskEvents':list(tasks.values())}
            cloud_catalog, materials, facts,routes = export_planning(vault, catalog, bundle, context, catalog_loader=loader)
            if head and head['sourceHash'] == bundle['snapshot']['sourceHash'] and head['items'] == bundle['snapshot']['items']:
                frozen = self.inbox.get_export(owner, link['libraryId'], head['snapshotId'])
                frozen_planning = self.inbox.get_planning(owner, link['libraryId'], head['snapshotId'])
                if (frozen is not None and frozen['bindings'] == bindings and frozen_planning is not None
                        and frozen_planning['catalog']['sourceHash'] == cloud_catalog['sourceHash'] and frozen_planning['materials'] == materials and frozen_planning['routes']==routes):
                    rebound=rebind_planning_facts(facts,frozen_planning['catalog'])
                    if not self._same_facts(frozen_planning.get('facts'), rebound):
                        self.inbox.queue_planning(owner,link['libraryId'],head['snapshotId'],frozen_planning['catalog'],materials,rebound,routes)
                    return None
            # Prepare source/queue baselines first. Inbox then atomically stores
            # the immutable export + publication job before any network upload.
            writer.prepare_snapshot(bundle, bindings)
            return bundle, bindings, cloud_catalog, materials, facts,routes

        def plan_processor(operations):
            results=[]
            for operation in operations:
                plan=operation['plan'];cloud_hash=plan['cloudPlanHash'] if plan else ''
                try:
                    frozen=self.inbox.planning_for_catalog(owner,link['libraryId'],plan['catalogHash']) if plan else None
                    if not frozen: raise ValueError('material-missing')
                    gateway_catalog,identities=capture_catalog(vault, catalog_loader=loader);old_bundle=self.inbox.get_export(owner,link['libraryId'],frozen['catalog']['snapshotId'])
                    if not old_bundle: raise ValueError('material-missing')
                    old_snapshot=old_bundle['bundle']['snapshot']
                    current_bundle,_=export_catalog(gateway_catalog,identities,link['libraryId'],old_snapshot['snapshotId'],old_snapshot['revision'],old_snapshot['generatedAt'],event_cursor=old_snapshot['eventCursor'],task_cursor=old_snapshot['taskCursor'])
                    context=self.planning_provider(vault,gateway_catalog,owner) if self.planning_provider else None
                    current_cloud,current_materials,_,current_routes=export_planning(vault,gateway_catalog,current_bundle,context,catalog_loader=loader)
                    validate_plan_source_bindings(plan, frozen['catalog'], frozen['materials'], frozen['routes'], current_cloud, current_materials, current_routes)
                    native=context['catalog'] if context else planning_catalog.load_planning_catalog(vault,gateway_catalog)
                    predecessor=self.inbox.latest_plan_result(owner,link['libraryId'],operation['predecessorOperationId']) if operation['predecessorOperationId'] else None
                    results.append(apply_operation(vault,owner,operation,native,frozen['materials'],predecessor))
                except OSError:
                    results.append({'operationId':operation['operationId'],'cloudPlanHash':cloud_hash,'status':'blocked','reason':'storage-unavailable'})
                except ValueError as error:
                    code=str(error);reason='material-missing' if 'material' in code else 'source-changed' if 'source' in code or 'catalog' in code else 'local-plan-conflict' if 'revision' in code or 'stale' in code else 'plan-write-failed'
                    results.append({'operationId':operation['operationId'],'cloudPlanHash':cloud_hash,'status':'blocked','reason':reason})
            return results

        def content_processor(operations):
            return self.content_processor(vault,owner,operations) if self.content_processor else []

        def auxiliary(call,max_pages):
            self._owner(owner);self._library(owner,link['libraryId'])
            # Failure to open the new store is contained by BackgroundSync;
            # original records/plans keep their existing independent pipeline.
            path=self.path.with_name('assistance-study.db')
            inbox=assistance_sync.AssistanceInbox(path);aux_writer=assistance_sync.AssistanceVaultWriter(vault,owner,path)
            return assistance_sync.run_account(owner,link['libraryId'],inbox,aux_writer,writer,call,max_pages)

        return BackgroundSync(owner, link['grantId'], self.links, self.inbox, self.transport,
                              verify_owner=lambda user: verify_installation_owner(self.installation_database, owner, user),
                              processor=writer.process, publisher=publisher,plan_processor=plan_processor,content_processor=content_processor,assistance_sync=auxiliary,clock=self.clock, stop_event=stop_event)

    @staticmethod
    def _same_facts(left, right):
        if left is None: return False
        excluded={'factsHash','observedAt'}
        return {key:value for key,value in left.items() if key not in excluded} == {key:value for key,value in right.items() if key not in excluded}

    def start(self, owner, grant, *, resume=False):
        link = self._link(owner, grant); self._library(owner, link['libraryId'])
        with self.lock:
            if self.closing:
                raise ValueError('account-service-stopping')
            existing = self.workers.get(grant)
            if existing and (existing['thread'] is None or existing['thread'].is_alive()):
                return {'status': existing['status'], 'grantId': grant}
            generation = self.generations.get(owner, 0) + 1
            self.generations[owner] = generation
            for old in self.workers.values():
                if old['owner'] == owner and old['thread'] is None:
                    old['stop'].set(); old['pauseRequested'] = True
            handle = {'thread': None, 'stop': threading.Event(), 'firstTick': threading.Event(), 'status': 'starting', 'owner': owner,
                      'error': None, 'pauseRequested': False, 'generation': generation}
            self.workers[grant] = handle
        try:
            sync = self._worker(owner, link, handle['stop'])
            if not resume:
                sync.activate()
            elif link['state'] != 'active':
                raise ValueError('account-link-not-active')
            predecessors = []
            with self.lock:
                if handle['pauseRequested'] or self.generations.get(owner) != generation:
                    self.links.mark_state(owner, grant, 'paused')
                    raise ValueError('account-service-stopping')
                if self.closing or handle['stop'].is_set():
                    raise ValueError('account-service-stopping')
                for old_grant, old in self.workers.items():
                    if old_grant != grant and old['owner'] == owner and old['thread'] is not None and old['thread'].is_alive():
                        old['stop'].set(); old['status'] = 'stopping'; predecessors.append(old['thread'])
                        self.links.mark_state(owner, old_grant, 'paused')
                thread = threading.Thread(target=self._loop, args=(owner, link, sync, handle, predecessors), daemon=True, name='zhixue-account-sync')
                handle['thread'] = thread; handle['status'] = 'running'; thread.start()
            return {'status': 'running', 'grantId': grant}
        except BaseException:
            with self.lock:
                if self.workers.get(grant) is handle:
                    self.workers.pop(grant, None)
            raise

    def _loop(self, owner, link, sync, handle, predecessors):
        try:
            for prior in predecessors:
                while prior.is_alive() and not handle['stop'].is_set():
                    prior.join(0.1)
            while not handle['stop'].is_set():
                try:
                    self._owner(owner); self._library(owner, link['libraryId'])
                    result = sync.run_once()
                    handle['status'] = result['status']; handle['error'] = result.get('error')
                except (ValueError, sqlite3.Error, OSError):
                    self.links.mark_state(owner, link['grantId'], 'paused')
                    handle['status'] = 'paused'; handle['error'] = 'account-local-configuration-required'
                finally:
                    handle['firstTick'].set()
                if handle['status'] in ('paused', 'stopped', 'not-started') or handle['stop'].wait(self.interval):
                    break
        finally:
            if handle['stop'].is_set():
                handle['status'] = 'stopped'
            handle['firstTick'].set()

    def stop(self, owner, grant, *, timeout=1):
        self._link(owner, grant)
        with self.lock:
            handle = self.workers.get(grant)
            if handle:
                handle['pauseRequested'] = True
                handle['stop'].set(); handle['status'] = 'stopping'
                thread = handle['thread']
            else:
                thread = None
        # Mark the stop intent before persisting it, so a concurrent activation
        # cannot write active after our pause but before noticing the stop.
        self.links.mark_state(owner, grant, 'paused')
        if thread:
            thread.join(max(0, min(timeout, 5)))
        return {'status': 'stopping' if thread and thread.is_alive() else 'stopped', 'cloudRevoked': False}

    def status(self, owner):
        self._owner(owner)
        result = []
        with self.lock:
            for link in self.links.list_links(owner):
                handle = self.workers.get(link['grantId'])
                result.append({key: link[key] for key in ('grantId', 'libraryId', 'label', 'state')})
                result[-1]['workerStatus'] = handle['status'] if handle else 'stopped'
                if handle and handle['error']:
                    result[-1]['error'] = handle['error']
        return {'capability': CAPABILITY, 'links': result}

    def resume(self):
        identity = _installation_identity(self.installation_database)
        if not identity:
            return
        for link in self.links.list_links(identity[0]):
            if link['state'] == 'active':
                try:
                    self.start(identity[0], link['grantId'], resume=True)
                except (ValueError, sqlite3.Error, OSError):
                    self.links.mark_state(identity[0], link['grantId'], 'paused')

    def shutdown(self):
        with self.lock:
            self.closing = True; handles = list(self.workers.values())
            for handle in handles:
                handle['stop'].set()
        for handle in handles:
            if handle['thread']:
                handle['thread'].join(1)
