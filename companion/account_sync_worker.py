"""Bounded, stoppable account sync. Never imports the live Companion server."""
from __future__ import annotations

import json
import re
import sqlite3
import threading
from datetime import datetime, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import HTTPRedirectHandler, Request, build_opener

from account_sync_credentials import machine_token_hash, trusted_origin
from account_sync_schema import canonical_json, study_count, study_iso, study_object, validate_receipt, validate_snapshot


class CloudFailure(ValueError):
    def __init__(self, status, code):
        self.status = status
        self.code = code if type(code) is str and re.fullmatch('[a-z0-9-]{1,80}', code) else 'account-cloud-error'
        super().__init__(self.code)


class AccountBindingFailure(ValueError):
    pass


class SyncStopped(Exception):
    pass


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError('duplicate-cloud-json-key')
        result[key] = value
    return result


class HttpTransport:
    GET_ACTIONS = {'grant-info', 'bootstrap', 'manifest', 'items', 'records', 'receipts', 'plan-operations', 'plan-executions','content-decisions','assistance'}
    POST_ACTIONS = {'activate-grant', 'begin-snapshot', 'stage-items', 'complete-snapshot', 'append-records', 'writeback-receipt', 'publish-planning-catalog', 'publish-planning-facts', 'claim-plan-operation','plan-execution-receipt','content-decision-receipt','assistance-receipt'}

    def __init__(self, allowed_origins, *, timeout=15, opener=None):
        if not 1 <= timeout <= 30:
            raise ValueError('invalid-account-timeout')
        self.allowed_origins = tuple(allowed_origins); self.timeout = timeout
        self.opener = opener or build_opener(_NoRedirect())

    def request(self, method, origin, secret, action, *, params=None, payload=None):
        trusted_origin(origin, self.allowed_origins); machine_token_hash(secret)
        if (method == 'GET' and action not in self.GET_ACTIONS) or (method == 'POST' and action not in self.POST_ACTIONS) or method not in ('GET', 'POST'):
            raise ValueError('invalid-account-action')
        if params is not None and (method != 'GET' or type(params) is not dict or set(params) - {'libraryId', 'snapshotId', 'position', 'after', 'through', 'limit'}):
            raise ValueError('invalid-account-query')
        url = origin + '/api/account-study'
        body = None
        if method == 'GET':
            if payload is not None:
                raise ValueError('invalid-account-payload')
            url += '?' + urlencode({'action': action, **(params or {})})
        else:
            if payload is not None and (type(payload) is not dict or 'action' in payload):
                raise ValueError('invalid-account-payload')
            body = canonical_json({'action': action, **(payload or {})}).encode('utf-8')
            if len(body) > 2200000:
                raise ValueError('account-request-too-large')
        request = Request(url, data=body, method=method, headers={'Authorization': 'Bearer ' + secret,
                          'Content-Type': 'application/json', 'Accept': 'application/json',
                          'User-Agent': 'ZhixueCompanion/1'})
        try:
            response = self.opener.open(request, timeout=self.timeout)
        except HTTPError as error:
            with error:
                raw = error.read(8193)
                code = 'account-cloud-error'
                if len(raw) <= 8192:
                    try:
                        data = json.loads(raw.decode('utf-8'))
                        if type(data) is dict:
                            code = data.get('error', code)
                    except (UnicodeError, ValueError):
                        pass
                raise CloudFailure(error.code, code) from None
        except (OSError, URLError):
            raise OSError('account-network-unavailable') from None
        with response:
            # Default opener never follows redirects; verify injected transports
            # and unexpected responses too, before trusting returned content.
            if response.geturl() != url or response.status != 200:
                raise CloudFailure(response.status, 'unexpected-account-response')
            if response.headers.get_content_type() != 'application/json':
                raise ValueError('invalid-account-response-type')
            raw = response.read(2200001)
        if len(raw) > 2200000:
            raise ValueError('account-response-too-large')
        def invalid_constant(_): raise ValueError('invalid-cloud-json-number')
        try:
            result = json.loads(raw.decode('utf-8'), object_pairs_hook=_unique_object, parse_constant=invalid_constant)
        except (UnicodeError, ValueError, RecursionError):
            raise ValueError('invalid-account-response-json') from None
        if type(result) is not dict:
            raise ValueError('invalid-account-response-json')
        return result


class BackgroundSync:
    def __init__(self, owner_id, grant_id, links, inbox, transport, *, verify_owner, processor,
                 publisher=None, plan_processor=None, content_processor=None, assistance_sync=None, clock=None, stop_event=None):
        self.owner_id = owner_id; self.grant_id = grant_id; self.links = links; self.inbox = inbox
        self.transport = transport; self.verify_owner = verify_owner; self.processor = processor; self.publisher = publisher
        self.plan_processor=plan_processor;self.content_processor=content_processor;self.clock = clock or (lambda: datetime.now(timezone.utc)); self.stop_event = stop_event or threading.Event()
        self.assistance_sync=assistance_sync
        self.lock = threading.Lock()

    def _running(self):
        if self.stop_event.is_set():
            raise SyncStopped()

    def _link(self):
        link = next((link for link in self.links.list_links(self.owner_id) if link['grantId'] == self.grant_id), None)
        if not link:
            raise AccountBindingFailure('unknown-account-link')
        return link

    def _call(self, link, secret, method, action, **kwargs):
        self._running()
        result = self.transport.request(method, link['origin'], secret, action, **kwargs)
        self._running()
        if type(result) is not dict:
            raise ValueError('invalid-account-response-json')
        return result

    def _principal(self, info, link, *, active=False):
        try:
            study_object(info, ['kind', 'userId', 'libraryId', 'grantId', 'state', 'expiresAt'])
            study_iso(info['expiresAt'])
            expires = datetime.fromisoformat(info['expiresAt'].replace('Z', '+00:00'))
            if (info['kind'] != 'device' or info['state'] not in ('pending', 'active') or (active and info['state'] != 'active')
                    or info['libraryId'] != link['libraryId'] or info['grantId'] != link['grantId'] or expires <= self.clock()
                    or type(info['userId']) is not str or not self.verify_owner(info['userId'])):
                raise ValueError('mismatched-principal')
        except (ValueError, TypeError, OverflowError):
            raise AccountBindingFailure('account-machine-binding') from None

    def activate(self):
        if not self.lock.acquire(blocking=False):
            raise ValueError('account-sync-busy')
        try:
            link = self._link()
            if link['state'] == 'revoked':
                raise ValueError('revoked-account-link')
            secret = self.links.secret(self.owner_id, self.grant_id)
            info = self._call(link, secret, 'GET', 'grant-info'); self._principal(info, link)
            if info['state'] == 'pending':
                info = self._call(link, secret, 'POST', 'activate-grant')
            self._principal(info, link, active=True)
            self.links.mark_state(self.owner_id, self.grant_id, 'active')
            return {'state': 'active', 'libraryId': link['libraryId']}
        finally:
            self.lock.release()

    def _publish_planning(self,link,secret,library):
        pending=self.inbox.pending_planning(self.owner_id,library)
        if not pending:return None
        try:
            if pending['catalogPending']:
                result=self._call(link,secret,'POST','publish-planning-catalog',payload={'catalog':pending['catalog']})
                if result.get('status') not in ('accepted','duplicate'):raise ValueError('account-planning-not-accepted')
            if 'facts' in pending:
                result=self._call(link,secret,'POST','publish-planning-facts',payload={'facts':pending['facts']})
                if result.get('status') not in ('accepted','duplicate'):raise ValueError('account-planning-facts-not-accepted')
            self.inbox.ack_planning(self.owner_id,library,pending['catalog']['snapshotId'],pending['catalog']['catalogHash'],pending.get('facts',{}).get('factsHash'))
            return None
        except (CloudFailure,OSError,ValueError):return 'account-planning-publication-blocked'

    def _publish(self, link, secret, max_pages):
        planning_error = None
        library = link['libraryId']; job = self.inbox.pending_publication(self.owner_id, library)
        if not job and self.publisher:
            boot = self._call(link, secret, 'GET', 'bootstrap')
            profile = study_object(boot.get('profile'), ['libraryId', 'revision'])
            study_count(profile['revision'])
            if boot.get('apiVersion') != 1 or boot.get('enabled') is not True or profile['libraryId'] != library:
                raise AccountBindingFailure('account-bootstrap-binding')
            snapshot = validate_snapshot(boot['snapshot']) if boot.get('snapshot') is not None else None
            if snapshot and snapshot['libraryId'] != library:
                raise AccountBindingFailure('account-bootstrap-binding')
            prepared = self.publisher(snapshot)
            if prepared is not None:
                if len(prepared) >= 4:
                    bundle, bindings, planning_catalog, materials, *fact_values = prepared
                    planning = (planning_catalog, materials, *fact_values)
                else:
                    bundle, bindings = prepared; planning = None
                if bundle['snapshot']['libraryId'] != library:
                    raise ValueError('account-export-binding')
                self.inbox.start_publication(self.owner_id, bundle, bindings, snapshot['revision'] if snapshot else 0, planning=planning)
                job = self.inbox.pending_publication(self.owner_id, library)
        if not job:return self._publish_planning(link,secret,library)
        snapshot = job['bundle']['snapshot']; snapshot_id = snapshot['snapshotId']
        if not job['begun']:
            result = self._call(link, secret, 'POST', 'begin-snapshot', payload={'snapshot': snapshot})
            if result.get('accepted') is not True:
                raise ValueError('account-publication-not-accepted')
            self.inbox.advance_publication(self.owner_id, library, snapshot_id, job, begun=True, position=0)
            job = self.inbox.pending_publication(self.owner_id, library)
        for _ in range(max_pages):
            position = job['position']; items = job['bundle']['items'][position:position + 20]
            if not items:
                break
            result = self._call(link, secret, 'POST', 'stage-items', payload={'snapshotId': snapshot_id,
                                'entries': [{'position': position + i, 'item': item} for i, item in enumerate(items)]})
            if result.get('accepted') is not True:
                raise ValueError('account-stage-not-accepted')
            self.inbox.advance_publication(self.owner_id, library, snapshot_id, job, begun=True, position=position + len(items))
            job = self.inbox.pending_publication(self.owner_id, library)
        if job['position'] == len(job['bundle']['items']):
            result = self._call(link, secret, 'POST', 'complete-snapshot', payload={'snapshotId': snapshot_id, 'expectedRevision': job['expectedRevision']})
            if result.get('status') not in ('accepted', 'duplicate'):
                raise ValueError('account-publication-conflict')
            # complete-snapshot reports current head revision even for a
            # historical duplicate. The fixed-ID manifest proves this job.
            study_count(result.get('revision'), minimum=snapshot['revision'])
            actual = validate_snapshot(self._call(link, secret, 'GET', 'manifest', params={'snapshotId': snapshot_id}))
            if actual != snapshot:
                raise ValueError('account-publication-integrity')
            self.inbox.advance_publication(self.owner_id, library, snapshot_id, job, begun=True, position=job['position'], complete=True)
        return self._publish_planning(link,secret,library) or planning_error

    def _receipts(self, link, secret):
        for receipt in self.inbox.pending_receipts(self.owner_id, link['libraryId']):
            result = self._call(link, secret, 'POST', 'writeback-receipt', payload={'receipt': receipt})
            if result.get('status') not in ('accepted', 'duplicate'):
                raise ValueError('account-writeback-receipt-conflict')
            stored = study_object(result.get('receipt'), ['sequence', 'receipt'], ['delivery', 'receivedAt', 'writerGrantId'])
            if validate_receipt(stored.get('receipt')) != receipt:
                raise ValueError('account-writeback-receipt-binding')
            sequence = study_count(stored.get('sequence'), minimum=1)
            self.inbox.ack_receipt(self.owner_id, link['libraryId'], receipt['receiptId'], sequence)

    def _plans(self,link,secret,max_pages):
        library=link['libraryId']
        for _ in range(max_pages):
            cursor=self.inbox.plan_cursor(self.owner_id,library);params={'after':cursor['after'],'limit':20}
            if cursor['through'] is not None:params['through']=cursor['through']
            page=self._call(link,secret,'GET','plan-operations',params=params);self.inbox.receive_plan_page(self.owner_id,library,page,after=cursor['after'])
            if page['nextCursor'] is None:break
        cursor=self.inbox.plan_cursor(self.owner_id,library)
        if cursor['through'] is None and self.plan_processor:
            for operation in self.inbox.pending_plan_operations(self.owner_id,library):
                claimed=self._call(link,secret,'POST','claim-plan-operation',payload={'operationId':operation['operationId']})
                if claimed.get('status') not in ('accepted','duplicate') or claimed.get('operationId')!=operation['operationId']:raise ValueError('account-plan-claim-conflict')
                for result in self.plan_processor([operation]):self.inbox.set_plan_result(self.owner_id,library,result)
        for receipt in self.inbox.pending_plan_receipts(self.owner_id,library):
            claimed=self._call(link,secret,'POST','claim-plan-operation',payload={'operationId':receipt['operationId']})
            if claimed.get('status') not in ('accepted','duplicate'):raise ValueError('account-plan-claim-conflict')
            response=self._call(link,secret,'POST','plan-execution-receipt',payload={'receipt':receipt})
            if response.get('status') not in ('accepted','duplicate'):raise ValueError('account-plan-receipt-conflict')
            execution=response.get('execution',{});sequence=study_count(execution.get('sequence'),minimum=1)
            if execution.get('receipt')!=receipt:raise ValueError('account-plan-receipt-binding')
            self.inbox.ack_plan_receipt(self.owner_id,library,receipt['receiptId'],sequence)

    def _content(self,link,secret,max_pages):
        library=link['libraryId']
        for _ in range(max_pages):
            cursor=self.inbox.content_cursor(self.owner_id,library);params={'after':cursor['after'],'limit':20}
            if cursor['through'] is not None:params['through']=cursor['through']
            page=self._call(link,secret,'GET','content-decisions',params=params);self.inbox.receive_content_page(self.owner_id,library,page,after=cursor['after'])
            if page['nextCursor'] is None:break
        cursor=self.inbox.content_cursor(self.owner_id,library)
        if cursor['through'] is None and self.content_processor:
            for result in self.content_processor(self.inbox.pending_content_operations(self.owner_id,library)):self.inbox.set_content_result(self.owner_id,library,result)
        for receipt in self.inbox.pending_content_receipts(self.owner_id,library):
            response=self._call(link,secret,'POST','content-decision-receipt',payload={'receipt':receipt})
            if response.get('status') not in ('accepted','duplicate'):raise ValueError('account-content-receipt-conflict')
            execution=response.get('execution',{})
            if execution.get('receipt')!=receipt:raise ValueError('account-content-receipt-binding')
            self.inbox.ack_content_receipt(self.owner_id,library,receipt['receiptId'],study_count(execution.get('sequence'),minimum=1))

    def run_once(self, *, max_pages=3):
        study_count(max_pages, minimum=1)
        if max_pages > 10:
            raise ValueError('invalid-account-sync-page-budget')
        if not self.lock.acquire(blocking=False):
            return {'status': 'busy'}
        try:
            self._running(); link = self._link()
            if link['state'] != 'active':
                return {'status': 'not-started' if link['state'] == 'prepared' else 'paused'}
            secret = self.links.secret(self.owner_id, self.grant_id)
            self._principal(self._call(link, secret, 'GET', 'grant-info'), link, active=True)
            publication_error = None
            try:
                publication_error = self._publish(link, secret, max_pages)
            except CloudFailure as error:
                if error.status not in (400, 404, 409, 413, 422):
                    raise
                publication_error = 'account-publication-blocked'
            except (AccountBindingFailure, OSError):
                raise
            except ValueError:
                # Invalid current source must not starve previously queued
                # practice against an older valid frozen snapshot.
                publication_error = 'account-publication-blocked'
            library = link['libraryId']
            for _ in range(max_pages):
                cursor = self.inbox.cursor(self.owner_id, library)
                params = {'after': cursor['after'], 'limit': 20}
                if cursor['through'] is not None:
                    params['through'] = cursor['through']
                page = self._call(link, secret, 'GET', 'records', params=params)
                self.inbox.receive_page(self.owner_id, library, page, after=cursor['after'])
                if page['nextCursor'] is None:
                    break
            cursor = self.inbox.cursor(self.owner_id, library)
            if cursor['through'] is None:
                self._running()
                records = self.inbox.records_through(self.owner_id, library)
                pending = [row for row in records if row['status'] != 'applied']
                if pending:
                    results = self.processor(records, pending)
                    self._running()
                    for result in results:
                        study_object(result, ['eventId', 'status'], ['reason', 'proof'])
                        self.inbox.set_result(self.owner_id, library, result['eventId'], result['status'], reason=result.get('reason'), proof=result.get('proof'))
            self._receipts(link, secret)
            auxiliary=None
            if self.assistance_sync:
                try:
                    auxiliary=self.assistance_sync(lambda method,action,**kwargs:self._call(link,secret,method,action,**kwargs),max_pages)
                except CloudFailure as error:
                    if error.status in (401,403): raise
                    auxiliary={'status':'retry','error':'assistance-cloud-unavailable'}
                except (OSError,sqlite3.Error):auxiliary={'status':'retry','error':'assistance-storage-or-network-unavailable'}
                except (ValueError,KeyError,TypeError):auxiliary={'status':'blocked','error':'assistance-integrity-check'}
            self._plans(link,secret,max_pages)
            self._content(link,secret,max_pages)
            return {'status': 'downloading' if cursor['through'] is not None else 'partial' if publication_error else 'synced',
                    'completeThrough': cursor['completeThrough'], **({'error': publication_error} if publication_error else {}),**({'assistance':auxiliary} if auxiliary is not None else {})}
        except SyncStopped:
            return {'status': 'stopped'}
        except (CloudFailure, AccountBindingFailure) as error:
            if isinstance(error, AccountBindingFailure) or error.status in (401, 403):
                self.links.mark_state(self.owner_id, self.grant_id, 'paused')
                return {'status': 'paused', 'error': 'account-authorization-required'}
            return {'status': 'retry', 'error': error.code}
        except (OSError, sqlite3.Error):
            return {'status': 'retry', 'error': 'account-network-or-storage-unavailable'}
        except (ValueError, KeyError, TypeError):
            return {'status': 'blocked', 'error': 'account-sync-integrity-check'}
        finally:
            self.lock.release()
