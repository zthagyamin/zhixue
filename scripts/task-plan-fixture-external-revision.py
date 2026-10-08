"""Create one competing revision only in this harness's disposable vault."""
import argparse
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'companion'))
import index_gateway
import plan_area
import planning_catalog
from task_plan_schema import hash_task_plan

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--vault', required=True)
args = parser.parse_args()
vault = Path(args.vault).resolve(strict=True)
if vault.name != 'vault' or not vault.parent.name.startswith('zhixue-task-plan-browser-') or vault.parent.parent != Path(tempfile.gettempdir()).resolve():
    raise ValueError('Only disposable task-plan browser vaults are allowed')
area = plan_area.plan_area_root(vault)
current = plan_area.current_payload(area)
candidate = current['candidate']
if not candidate or candidate.get('schemaVersion') != 2:
    raise ValueError('Save a fixture task plan before creating the competing revision')
if any(task['taskId'] == 'fixture:other-device' for task in candidate['tasks']):
    raise ValueError('Competing fixture task already exists')
catalog = planning_catalog.load_planning_catalog(vault, index_gateway.load_gateway(vault))
candidate['sourceHash'] = catalog['sourceHash']
candidate['tasks'].append({'taskId': 'fixture:other-device', 'subjectId': 'science', 'title': '另一个客户端的测试任务',
    'category': 'subject', 'origin': 'manual', 'required': False, 'unitIds': [], 'quantity': 1,
    'action': {'kind': 'manual'}, 'completionRule': 'self-report', 'sourceHash': catalog['sourceHash']})
candidate['manual']['lockedTaskIds'].append('fixture:other-device')
candidate['draftVersion'] += 1
candidate['planHash'] = hash_task_plan(candidate)
revision = plan_area.apply_plan_revision(area, candidate, 'fixture-other-device', 'isolated-browser-test', expected_revision=current['revision'])
print('Created disposable competing revision:', revision['revision'])
