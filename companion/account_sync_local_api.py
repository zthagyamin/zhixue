"""Small paired HTTP adapter; no live-server imports and no raw error echoes."""
from __future__ import annotations

from account_sync_schema import study_id, study_object, study_text
from account_sync_worker import AccountBindingFailure, CloudFailure, SyncStopped


def dispatch(service, method, path, owner, origin, allowed_origins, payload=None):
    if not owner:
        return 401, {'error': 'companion-pairing-required', 'message': '请先用当前登录账号配对 Companion。'}
    if origin not in allowed_origins:
        return 403, {'error': 'companion-origin-not-allowed', 'message': '该网页来源未被本机授权。'}
    def runtime():
        return service() if callable(service) else service
    try:
        if method == 'GET' and path == '/v1/account-sync/status':
            return 200, runtime().status(owner)
        if method != 'POST' or path not in ('/v1/account-sync/prepare', '/v1/account-sync/start', '/v1/account-sync/stop'):
            return 404, {'error': 'account-sync-action-not-found'}
        if path.endswith('/prepare'):
            study_object(payload, ['label'],['rotateGrant']); study_text(payload['label'], 'label', 80)
            if 'rotateGrant' in payload and type(payload['rotateGrant']) is not bool:raise ValueError('invalid-rotate-grant')
            return 200, runtime().prepare(owner, origin, payload['label'],rotate=True) if payload.get('rotateGrant',False) else runtime().prepare(owner, origin, payload['label'])
        study_object(payload, ['grantId']); study_id(payload['grantId'], 'grant')
        if path.endswith('/start'):
            return 200, runtime().start(owner, payload['grantId'])
        return 200, runtime().stop(owner, payload['grantId'])
    except (CloudFailure, AccountBindingFailure):
        return 409, {'error': 'account-cloud-link-not-ready', 'message': '云端授权未就绪或已变化，请刷新账号同步设置后重试。'}
    except SyncStopped:
        return 409, {'error': 'account-sync-start-cancelled', 'message': '启动已被停止操作或更新的连接请求取消。'}
    except ValueError as error:
        if str(error) == 'account-installation-owner-mismatch':
            return 403, {'error': 'account-installation-owner-mismatch', 'message': '当前账号与本机配对身份不一致。'}
        return 400, {'error': 'account-sync-invalid-request', 'message': '请求、来源资料或连接状态未通过校验，请刷新后重试。'}
    except Exception:
        return 503, {'error': 'account-sync-runtime-unavailable', 'message': '本机存储或后台服务暂不可用，已有记录会保留。'}
