"""Candidate install/upgrade/rollback with real, synthetic SQLite recovery state.

No protocol registration, environment setup, installed server or real Vault is
used. The one failing setup is an exact test script, not production setup.
"""
import argparse
import hashlib
import json
import os
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import uuid
from contextlib import closing
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
FAULT_SETUP = '''param([switch]$NoStart)
if (-not $NoStart) { throw 'Fixture requires NoStart' }
Write-Output 'G5_AFTER_PROGRAM_COPY'
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'data/study-loop.db'), 'G5 synthetic interruption')
throw 'G5_INJECTED_SETUP_FAILURE'
'''


def safe_root(path):
    root = Path(path).resolve()
    if root.parent != Path(tempfile.gettempdir()).resolve() or not root.name.startswith('zhixue-g5-') or len(root.name) <= len('zhixue-g5-'):
        raise ValueError('A dedicated zhixue-g5 temporary root is required')
    return root


def installer_command(payload, target, backups, pwsh, *, fault=False):
    if fault and (payload / 'setup-and-start.ps1').read_text(encoding='utf-8') != FAULT_SETUP:
        raise ValueError('Only the exact inert failure fixture can run setup')
    command = [pwsh, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(payload/'install-or-upgrade.ps1'),
               '-PayloadRoot', str(payload), '-TargetPath', str(target), '-BackupBasePath', str(backups),
               '-NonInteractive', '-NoStart', '-SkipRegistration']
    if not fault: command.append('-SkipSetup')
    return command


def file_hash(path): return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def manifest(data, config, vault):
    return {'databases': {name: file_hash(data/name) for name in ('study-loop.db','account-study.db','assistance-study.db')},
            'config': file_hash(config), 'vault': {str(path.relative_to(vault)): file_hash(path) for path in sorted(vault.rglob('*')) if path.is_file()}}


def verify_program_files(installed, payload):
    expected = {str(path.relative_to(payload)): file_hash(path) for path in sorted(payload.rglob('*')) if path.is_file()}
    assert expected, 'The expected program payload must not be empty'
    for name, digest in expected.items():
        assert (installed/name).is_file() and file_hash(installed/name) == digest, 'Program mismatch: '+name
    return expected


def verify_resume_preserved(before, after):
    assert after['config'] == before['config']
    for name in ('account-study.db', 'study-loop.db'):
        assert after['databases'][name] == before['databases'][name]
    assert all(after['vault'][name] == digest for name, digest in before['vault'].items())
    assert len(after['vault']) == len(before['vault'])+1


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--root', required=True)
    parser.add_argument('--candidate', required=True)
    parser.add_argument('--reference', required=True)
    parser.add_argument('--pwsh', default='pwsh.exe')
    args = parser.parse_args()
    root = safe_root(args.root)
    candidate, reference = Path(args.candidate).resolve(), Path(args.reference).resolve()
    if not candidate.is_relative_to(root) or not reference.is_relative_to(root):
        raise ValueError('Payloads must be inside the explicit candidate workspace')
    run = root / ('retention-' + uuid.uuid4().hex)
    run.mkdir()
    target, seed, fresh = run/'installed', run/'seed', run/'fresh-install'
    seed.mkdir()
    allowed = {'PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC'}
    env = {key: value for key, value in os.environ.items() if key.upper() in allowed}
    env.update(PYTHONNOUSERSITE='1', PYTHONUTF8='1', LOCALAPPDATA=str(run/'profile/local'), APPDATA=str(run/'profile/roaming'), USERPROFILE=str(run/'profile'))
    for name in ('LOCALAPPDATA','APPDATA','USERPROFILE'): Path(env[name]).mkdir(parents=True, exist_ok=True)
    phases = []

    def install(payload, phase, *, destination=target, fault=False, restored_payload=None):
        result = subprocess.run(installer_command(payload,destination,run/'backups'/phase,args.pwsh,fault=fault), cwd=run, env=env, text=True, encoding='utf-8', errors='replace', capture_output=True)
        (run/(phase+'.log')).write_text(result.stdout+'\n'+result.stderr, encoding='utf-8')
        if fault:
            assert result.returncode != 0 and 'G5_AFTER_PROGRAM_COPY' in result.stdout and '旧版文件已恢复' in result.stdout, phase
        else:
            assert result.returncode == 0, phase+': '+result.stderr[-1000:]
        expected_payload = restored_payload if fault else payload
        assert expected_payload is not None, 'Fault rollback must declare the expected restored payload'
        programs = verify_program_files(destination, expected_payload)
        phases.append({'phase':phase,'exit':result.returncode,'faultInjected':fault,'verifiedProgramFiles':programs})

    def inspect(payload=target, *, resume=False):
        command = [sys.executable,'-I','-B',str(REPO/'scripts/inspect-companion-candidate.py'),'--payload',str(payload),'--data',str(target/'data'),'--owner',f.owner]
        if resume: command += ['--resume','--vault',str(f.vault)]
        result = subprocess.run(command,cwd=run,env=env,text=True,encoding='utf-8',errors='replace',capture_output=True)
        assert result.returncode == 0, result.stderr[-2000:]
        return json.loads(result.stdout.strip().splitlines()[-1])

    # Exact payload installation without setup/start/registration.
    install(candidate,'fresh',destination=fresh)
    modules = sorted(path.name for path in candidate.glob('*.py'))
    install(reference,'reference-install')
    sys.path.insert(0,str(REPO/'companion'))
    sys.path.insert(0,str(REPO/'tests'))
    import test_account_sync_writer as core_fixtures
    import test_assistance_writer as auxiliary_fixtures
    import server
    from account_sync_inbox import Inbox
    from account_sync_writer import VerifiedVaultWriter
    from assistance_inbox import AssistanceInbox
    from assistance_writer import AssistanceVaultWriter
    from assistance_sync import process_pending
    f = core_fixtures.AccountSyncWriterTests()
    f.setUp()
    try:
        # Match production: Inbox and writer ledger share account-study.db.
        f.inbox = Inbox(seed/'account-study.db')
        f.ledger = seed/'account-study.db'
        f.writer = VerifiedVaultWriter(f.vault,f.owner,f.inbox,f.ledger)
        f.capture()
        parents = f.records()
        f.receive(parents)
        assert [value['status'] for value in f.apply()] == ['applied']*3
        server.LOCAL_DATABASE_PATH = seed/'study-loop.db'
        native = json.loads(json.dumps(parents[0]['event']))
        native['eventId'] = 'native-g5-before-upgrade'
        native['coreHash'] = server.compute_study_event_core_hash(native)
        with server.local_database() as db:
            db.execute('INSERT INTO installation_owner VALUES(1,?,?)',(f.owner,native['occurredAt']))
            db.execute('INSERT INTO study_events_v3(account_id,event_id,core_hash,occurred_at,event_json,local_context_json,accepted_at) VALUES(?,?,?,?,?,?,?)',
                       (f.owner,native['eventId'],native['coreHash'],native['occurredAt'],json.dumps(native),None,native['occurredAt']))
        auxiliary_path = seed/'assistance-study.db'
        auxiliary = AssistanceInbox(auxiliary_path)
        record = auxiliary_fixtures.AssistanceWriterTests().assistance(parents[0])
        auxiliary.receive_page(f.owner,'library-a',{'summaries':[{'sequence':1,'record':record,'receivedAt':'2026-09-01T00:00:00.000Z'}],'through':1,'nextCursor':None},after=0)
        writes = []
        def interrupt(path):
            writes.append(path)
            if len(writes) == 1: raise RuntimeError('candidate-upgrade-interruption')
        writer = AssistanceVaultWriter(f.vault,f.owner,auxiliary_path,after_write=interrupt)
        try:
            process_pending(f.owner,'library-a',auxiliary,lambda row:writer.apply_account(row['record'],f.writer))
        except RuntimeError as error:
            assert str(error) == 'candidate-upgrade-interruption'
        assert len(writes) == 1 and len(auxiliary.pending_receipts(f.owner,'library-a')) == 1
        # SQLite backup retains a complete image, including committed WAL data.
        data = target/'data'
        data.mkdir(exist_ok=True)
        for name in ('study-loop.db','account-study.db','assistance-study.db'):
            with closing(sqlite3.connect(seed/name)) as source, closing(sqlite3.connect(data/name)) as destination:
                source.backup(destination)
        config = target/'config.local.json'
        config.write_text(json.dumps({'learning_vault_root':str(f.vault),'fixture':'candidate-retention'}),encoding='utf-8')
        before = manifest(data,config,f.vault)
        old_read = inspect()
        assert old_read['version'] == '1.11.5' and old_read['coreCount'] == 3 and len(old_read['native']) == 1
        assert old_read['jobs'][0][-1] == 0 and len(old_read['receipts']) == 1

        fault_payload = run/'fault-payload'
        shutil.copytree(candidate,fault_payload)
        (fault_payload/'setup-and-start.ps1').write_text(FAULT_SETUP,encoding='utf-8',newline='\n')
        install(fault_payload,'interrupted-upgrade',fault=True,restored_payload=reference)
        assert manifest(data,config,f.vault) == before
        assert inspect() == old_read

        install(candidate,'upgrade')
        assert manifest(data,config,f.vault) == before
        current_read = inspect()
        assert current_read['version'] == '1.12.0'
        assert {k:v for k,v in current_read.items() if k!='version'} == {k:v for k,v in old_read.items() if k!='version'}

        install(reference,'program-rollback')
        assert manifest(data,config,f.vault) == before
        assert inspect() == old_read
        install(candidate,'re-upgrade')
        assert manifest(data,config,f.vault) == before

        resumed = inspect(resume=True)
        assert resumed['core'] == old_read['core'] and resumed['native'] == old_read['native']
        assert resumed['jobs'][0][-1] == 1 and len(resumed['receipts']) == 2
        after = manifest(data,config,f.vault)
        verify_resume_preserved(before, after)
        assert inspect(resume=True) == resumed
        assert manifest(data,config,f.vault) == after
        report = {'candidateVersion':'1.12.0','referenceVersion':'1.11.5','runRoot':str(run),'modules':len(modules),'phases':phases,
                  'oldRead':old_read,'resumed':resumed,'before':before,'after':after,
                  'registration':False,'environmentSetup':False,'realCompanionStarted':False,
                  'note':'Fresh Python processes validated old/new payload reads and resumed one incomplete auxiliary job; real machine setup/registration was not run.'}
        (run/'verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
        print(json.dumps({'passed':True,'evidence':str(run/'verification.json'),'phases':len(phases),'coreRecords':3,'nativeRecords':1,'auxiliaryReceiptsAfterResume':2,'repeatUnchanged':True},ensure_ascii=False))
    finally:
        f.doCleanups()


if __name__ == '__main__': main()
