"""Runs only from the copied disposable Companion in the UI harness."""
from pathlib import Path
from http.server import ThreadingHTTPServer
import sys

FIXTURE_ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(FIXTURE_ROOT))
for name in ('gateway_cli', 'index_gateway', 'server'):
    if name in sys.modules:
        filename = getattr(sys.modules[name], '__file__', None)
        if not isinstance(filename, str) or Path(filename).resolve().parent != FIXTURE_ROOT:
            raise RuntimeError('Preview must use only its copied Companion')
import gateway_cli
import index_gateway
import server

if any(Path(module.__file__).resolve().parent != FIXTURE_ROOT for module in (gateway_cli, index_gateway, server)):
    raise RuntimeError('Preview must use only its copied Companion')

vault=Path(server.CONFIG['learning_vault_root'])
gateway_cli.init(vault)
for subject_id,name in [('biology','生物学术语'),('chemistry','化学术语')]:
    gateway_cli.add_subject(vault,subject_id,name,subject_id,'three-stage',f'subjects/{subject_id}',1)
    (vault/f'subjects/{subject_id}/words.md').write_text('---\ntype: vocabulary-database\n---\n| word | meaning | context |\n|---|---|---|\n| cell | 细胞 | A cell grows. |\n| atom | 原子 | An atom is small. |\n',encoding='utf-8')
gateway_cli.add_subject(vault,'astronomy','天文学','astronomy','quiz','subjects/astronomy',20)
(vault/'subjects/astronomy/lesson.md').write_text('---\ntype: zhixue-content\nzhixue: true\nzhixue_id: lesson\nzhixue_format: quiz\n---\n| ID | 题干 | 选项 | 答案 | 解析 |\n|---|---|---|---|---|\n| q1 | Which planet is our home? | Earth;Mars | Earth | Earth is our home. |\n',encoding='utf-8')
server.PAIRING_CODE='TEST01'
server.deepseek_key=lambda:None
server.STATE={'status':'connected','contentMode':'personal','subjects':[]}
httpd=ThreadingHTTPServer(('127.0.0.1',int(server.CONFIG['port'])),server.Handler)
print('Disposable Companion fixture ready. Pairing code: TEST01',flush=True)
httpd.serve_forever()
