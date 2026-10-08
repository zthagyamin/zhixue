"""Disposable managed workspace for source UI tests. No external services."""
import threading
from http.server import ThreadingHTTPServer
from urllib.parse import urlparse
import server
import external_sources
import note_source_runtime
from notion_connector import NotionError

class Keys:
    def __init__(self):self.values={}
    def get_password(self,service,key):return self.values.get((service,key))
    def set_password(self,service,key,value):self.values[service,key]=value
class OfflineNotion:
    def __init__(self,*args):pass
    def read_page(self,*args):raise NotionError('notion-unauthorized')
class Handler(server.Handler):
    def do_POST(self):
        if urlparse(self.path).path not in ('/v1/pair','/v1/note-sources','/v1/setup','/v1/refresh','/v1/activity','/v1/session/revoke'):
            self.send_json(403,{'message':'隔离验收禁用外部写入。'});return
        return super().do_POST()
    def do_GET(self):
        if urlparse(self.path).path.startswith('/v1/account-sync'):
            self.send_json(403,{'message':'隔离验收禁用账号服务。'});return
        return super().do_GET()
server.PAIRING_CODE='NOTES1'
server.credential_key=lambda *args:None
server.deepseek_key=lambda:None
server.NOTE_SOURCE_RUNTIME=note_source_runtime.SourceRuntime(external_sources.ExternalSources(server.LOCAL_DATABASE_PATH.parent,lambda:server.source_path('learning_vault_root'),Keys(),verify_owner=lambda owner:owner==server.installation_owner_hash(),client_factory=OfflineNotion),server.validate_study_event_v3)
server.STATE={'status':'connected','contentMode':'personal','subjects':[]}
threading.Thread(target=server.note_source_loop,args=(threading.Event(),),daemon=True).start()
print('Isolated source Companion ready.',flush=True)
ThreadingHTTPServer(('127.0.0.1',server.CONFIG['port']),Handler).serve_forever()
