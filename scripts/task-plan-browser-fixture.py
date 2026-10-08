"""Disposable task-plan UI fixture; copied beside a temporary Companion, never the installed runtime."""
from datetime import datetime
from http.server import ThreadingHTTPServer
from pathlib import Path
from zoneinfo import ZoneInfo
import os
import gateway_cli
import index_gateway
import server
from urllib.parse import urlparse


class FixtureHandler(server.Handler):
    def do_GET(self):
        if urlparse(self.path).path.startswith('/v1/account-sync'):
            self.send_response(403)
            self.end_headers()
            self.wfile.write(b'Account machine setup is disabled in this fixture')
            return
        super().do_GET()

    def do_POST(self):
        route = urlparse(self.path).path
        allowed = ('/v1/plan/', '/v1/practice/', '/v1/review/', '/v1/events', '/v1/activity', '/v1/pair')
        if route != '/v1/assistance' and not route.startswith(allowed):
            self.send_response(403)
            self.end_headers()
            self.wfile.write(b'Configuration and external writes are disabled in this fixture')
            return
        super().do_POST()

def serve_fixture():
    server.PAIRING_CODE = 'TASK01'
    server.deepseek_key = lambda: None
    server.credential_key = lambda *args: None
    server.STATE = {'status': 'connected', 'contentMode': 'personal', 'subjects': []}

    print('Disposable task-plan Companion ready.', flush=True)
    ThreadingHTTPServer(('127.0.0.1', int(server.CONFIG['port'])), FixtureHandler).serve_forever()

if os.environ.get('TASK_PLAN_REUSE_VAULT') == '1':
    serve_fixture()
    raise SystemExit(0)

vault = Path(server.CONFIG['learning_vault_root'])
gateway_cli.init(vault)
for subject_id, name, plugin in [('words', '隔离词库', 'three-stage'), ('reading', '指标阅读', 'quiz'), ('science', '自主科学', 'quiz')]:
    gateway_cli.add_subject(vault, subject_id, name, 'ielts' if subject_id == 'words' else 'paper', plugin, f'subjects/{subject_id}', 20)
word_index = vault / index_gateway.GATEWAY_ROOT / 'subjects/words.md'
word_index.write_text(word_index.read_text(encoding='utf-8').replace('enabled: true', 'language: en\nenabled: true'), encoding='utf-8')

terms = 'apple book cell atom tree river paper cloud stone light water field plant earth ocean space energy force mass orbit galaxy planet star moon solar north south east west leaf root seed branch flower forest wind rain snow lake mountain'.split()
words = '| word | meaning | context |\n|---|---|---|\n' + ''.join(f'| {word} | 测试释义 {i + 1} | This is {word}. |\n' for i, word in enumerate(terms))
(vault / 'subjects/words/words.md').write_text('---\ntype: vocabulary-database\nlanguage: en\n---\n' + words, encoding='utf-8')
for subject in ['reading', 'science']:
    batches = [[i] for i in range(1, 5)] if subject == 'reading' else [list(range(1, 5))]
    for batch in batches:
        identity = f'lesson-{batch[0]}' if subject == 'reading' else 'lesson'
        rows = ''.join(f'| q{i} | Fixture question {i}: choose Earth. | Earth;Mars | Earth | Earth is the fixture answer. | 学习单元 {i} |\n' for i in batch)
        (vault / f'subjects/{subject}/{identity}.md').write_text(f'---\ntype: zhixue-content\nzhixue: true\nzhixue_id: {identity}\nzhixue_format: quiz\n---\n| ID | 题干 | 选项 | 答案 | 解析 | 主题 |\n|---|---|---|---|---|---|\n' + rows, encoding='utf-8')
day = datetime.now(ZoneInfo('Asia/Shanghai')).date().isoformat()
index = vault / index_gateway.GATEWAY_ROOT / 'subjects/reading.md'
index.write_text(index.read_text(encoding='utf-8').replace('enabled: true', 'planning_ref: "[[subjects/reading/goals]]"\nenabled: true'), encoding='utf-8')
(vault / 'subjects/reading/goals.md').write_text('---\nplanning_schema_version: 1\n---\n'
    '| goal_id | title | target_kind | target_count | unit_ids | start_on | due_on | priority | required | completion_basis |\n'
    '|---|---|---|---|---|---|---|---|---|---|\n'
    f'| daily | 每日两题 | daily | 2 | one,two,three,four | {day} | | 3 | true | practice-round |\n\n'
    '| unit_id | title | content_ref | state_ref | ability_id | order | prerequisites | action | completion_rule |\n'
    '|---|---|---|---|---|---|---|---|---|\n' + ''.join(f'| {name} | 阅读题 {i} | [[subjects/reading/lesson-{i}]] | | | {i} | | practice | graded-practice |\n' for i, name in enumerate(['one', 'two', 'three', 'four'], 1)), encoding='utf-8')
for number in range(int(os.environ.get('TASK_PLAN_REVIEW_COUNT', '2'))):
    state = 'subjects/science/知学练习/学习状态.md'
    (vault / f'subjects/science/review-{number}.md').write_text(f'---\ntype: learning-result\nitem_id: fixture-review-{number}\nability_id: fixture-review-{number}\nreview_enabled: true\nreview_date: {day}\nsource_note: "[[{state}]]"\nstate_ref: "[[{state}]]"\n---\n# 复习卡 {number + 1}\n\n复习要点：\n- Earth is the fixture answer.\n', encoding='utf-8')
serve_fixture()
