"""Local scanners on an immutable Git snapshot; never validate credentials."""
from __future__ import annotations
import hashlib
import io
import json
import os
from pathlib import Path
import subprocess
import tempfile
import zipfile

OUT = Path(os.environ['SECURITY_EVIDENCE'])
OUT.mkdir(parents=True, exist_ok=True)
TOOLS = Path(os.environ['SECURITY_TOOLS'])
ROOT = Path.cwd()
RECORDS = []


def run(name, command, cwd=ROOT, allowed=(0, 1), timeout=360):
    with (OUT / (name + '.log')).open('w') as log:
        try:
            result = subprocess.run(command, cwd=cwd, stdout=log, stderr=subprocess.STDOUT, timeout=timeout, check=False)
            record = {'tool': name, 'exit_code': result.returncode, 'completed': result.returncode in allowed}
        except Exception as error:
            record = {'tool': name, 'completed': False, 'error': type(error).__name__}
    RECORDS.append(record)
    return record


with tempfile.TemporaryDirectory(prefix='zhixue-security-') as directory:
    source = Path(directory) / 'source'
    source.mkdir()
    archive = subprocess.check_output(['git', 'archive', '--format=zip', 'HEAD'])
    with zipfile.ZipFile(io.BytesIO(archive)) as package:
        for entry in package.infolist():
            if Path(entry.filename).is_absolute() or '..' in Path(entry.filename).parts:
                raise ValueError('unsafe archive member')
        package.extractall(source)
    run('semgrep', ['semgrep', 'scan', '--config', 'p/security-audit', '--config', 'p/owasp-top-ten', '--metrics=off', '--disable-version-check', '--no-git-ignore', '--jobs', '2', '--timeout', '10', '--max-target-bytes', '3000000', '--json', '--output', str(OUT/'semgrep.json'), '.'], source, allowed=(0,))
    run('trivy', [str(TOOLS/'trivy'), 'fs', '--scanners', 'vuln,misconfig', '--include-dev-deps', '--skip-version-check', '--format', 'json', '--output', str(OUT/'trivy.json'), '--timeout', '5m', str(source)], allowed=(0,))
    raw = Path(directory) / 'secrets-private.json'
    # Raw candidate text stays in the disposable runner and is never uploaded.
    run('betterleaks', [str(TOOLS/'betterleaks'), 'dir', str(source), '--validation=false', '--no-banner', '--report-format', 'json', '--report-path', str(raw), '--timeout', '240'])
    reviewed = []
    if raw.exists():
        for item in json.loads(raw.read_text()) or []:
            secret = str(item.get('Secret', ''))
            path = str(item.get('File', '')).replace(str(source) + '/', '')
            safe = {key: item.get(key) for key in ['RuleID', 'StartLine', 'EndLine', 'Fingerprint', 'Description']}
            safe.update(File=path, secret_sha256=hashlib.sha256(secret.encode()).hexdigest(), secret_length=len(secret), classification='unverified')
            # Exact source/rule/digest matches are annotations, never suppressions.
            digest = safe['secret_sha256']
            if path == 'tests/test_companion.py' and item.get('RuleID') == 'generic-api-key' and digest == '6e673dcd68d9848b105b4332b580b51c2254d6fde836dc1200e9b53d345edd5d':
                safe['classification'] = 'synthetic-item-identifier'
            elif path == 'tests/test_account_sync_credentials.py' and item.get('RuleID') == 'generic-credential-uri' and digest == 'd74ff0ee8da3b9806b18c877dbf29bbde50b5bd8e4dad7a3a725000feb82e8f1':
                safe['classification'] = 'synthetic-invalid-uri'
            elif path.endswith('!python314.zip!getpass.pyc') and item.get('RuleID') == 'generic-password' and digest == '66b72c39295d41e28e83da7b55355bc4f915df8e47de1cb29ce1be7e6e55ad01':
                # Verified at byte offset 7916 in the shipped public CPython file:
                # 12 bytecode bytes following its ordinary password prompt.
                safe['classification'] = 'stdlib-bytecode-false-positive'
            reviewed.append(safe)
        raw.unlink()
    else:
        RECORDS[-1]['completed'] = False
        RECORDS[-1]['error'] = 'missing-secrets-report'
    (OUT/'secrets-review.json').write_text(json.dumps(reviewed, ensure_ascii=False, indent=2))
    (OUT/'betterleaks.log').unlink(missing_ok=True)
    # Audit the exact dependencies in the Windows distribution, not Linux packages.
    packages = {}
    with zipfile.ZipFile(source/'companion/runtime-windows-x64.zip') as runtime:
        for entry in runtime.namelist():
            if entry.endswith('.dist-info/METADATA'):
                fields = runtime.read(entry).decode('utf-8', 'replace').splitlines()
                name = next(line[6:] for line in fields if line.startswith('Name: '))
                version = next(line[9:] for line in fields if line.startswith('Version: '))
                packages[name] = version
    exact = Path(directory)/'packaged-requirements.txt'
    exact.write_text(''.join(f'{name}=={version}\n' for name, version in sorted(packages.items())))
    (OUT/'python-packaged-inventory.json').write_text(json.dumps(packages, indent=2))
    run('pip-audit-packaged', ['pip-audit', '--no-deps', '--disable-pip', '-r', str(exact), '-f', 'json', '-o', str(OUT/'pip-audit-packaged.json')])

summary = {'sha': subprocess.check_output(['git','rev-parse','HEAD'], text=True).strip(), 'credential_validation': False, 'live_scanning': False, 'executions': RECORDS}
for name in ['semgrep', 'trivy', 'pip-audit-packaged']:
    file = OUT/(name+'.json')
    if not file.exists():
        summary[name] = {'report': 'missing'}
        continue
    data = json.loads(file.read_text())
    if name == 'semgrep':
        summary[name] = {'findings':len(data.get('results',[])), 'errors':len(data.get('errors',[])), 'scanned_files':len(data.get('paths',{}).get('scanned',[]))}
        for item in data.get('results',[]):
            for key in ['lines','metavars','dataflow_trace']:
                item.get('extra',{}).pop(key,None)
        file.write_text(json.dumps(data,ensure_ascii=False,indent=2))
    elif name == 'trivy':
        summary[name] = {'vulnerability_occurrences':sum(len(item.get('Vulnerabilities',[]) or []) for item in data.get('Results',[]) or []), 'targets':[item.get('Target') for item in data.get('Results',[]) or []]}
    else:
        summary[name] = {'packages':len(data.get('dependencies',[])), 'vulnerability_occurrences':sum(len(item.get('vulns',[])) for item in data.get('dependencies',[]))}
summary['secrets'] = reviewed
(OUT/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2))
print(json.dumps(summary,ensure_ascii=False,indent=2))
if not all(record['completed'] for record in RECORDS) or any(summary.get(name, {}).get('report') == 'missing' for name in ['semgrep', 'trivy', 'pip-audit-packaged']):
    raise SystemExit('One or more scanners did not finish successfully.')
