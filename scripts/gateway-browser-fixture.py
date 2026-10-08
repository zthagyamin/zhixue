"""Runs only from the copied disposable Companion in the UI harness."""
from pathlib import Path
from http.server import ThreadingHTTPServer
import gateway_cli
import server

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
print('Disposable Companion fixture ready. Pairing code: TEST01',flush=True)
ThreadingHTTPServer(('127.0.0.1',43222),server.Handler).serve_forever()
