"""Run as root on the DB server after installing the history jobs; only a marked scratch database is written."""
import importlib.util
from pathlib import Path
import subprocess
import tempfile

spec = importlib.util.spec_from_file_location('history', '/usr/local/lib/gantt-db-history/db-history-backup.py')
history = importlib.util.module_from_spec(spec)
spec.loader.exec_module(history)
job = history.HistoryBackup('day1')
job.target = 'gantt_history_restore_test'
scratch_state = tempfile.TemporaryDirectory()
job.state = Path(scratch_state.name)
if job.database_marker(job.target):
    raise RuntimeError('Scratch database already exists; refusing to replace it')
try:
    custom = max(job.history.glob(f'{job.source}_*.dump'))
    job.restore(custom)
    before = job.sql('SELECT details::text FROM backup_metadata.snapshot', job.target)
    assert job.sql('SHOW default_transaction_read_only', job.target) == 'on'
    assert job.counts(job.target)['tasks'] > 0
    with tempfile.TemporaryDirectory() as directory:
        corrupt = Path(directory) / custom.name
        corrupt.write_bytes(b'not a valid PostgreSQL archive')
        try:
            job.restore(corrupt)
        except subprocess.CalledProcessError:
            pass
        else:
            raise AssertionError('Corrupt archive unexpectedly restored')
    assert job.sql('SELECT details::text FROM backup_metadata.snapshot', job.target) == before
    leftovers = job.sql("SELECT datname FROM pg_database WHERE datname LIKE 'gantt_history_restore_test_new_%'")
    assert not leftovers, leftovers
    for slot, days in [('day1', 1), ('day7', 7)]:
        check = history.HistoryBackup(slot)
        details = __import__('json').loads(check.sql('SELECT details::text FROM backup_metadata.snapshot', check.target))
        assert __import__('datetime').date.fromisoformat(details['snapshot_at'][:10]) == (check.now - history.timedelta(days=days)).date()
        assert check.counts(check.target) == details['tables']
        assert check.database_marker(check.target)['comment'] == check.marker
        print('PASS', check.target, details['snapshot_at'], 'tables=', len(details['tables']), 'tasks=', details['tables']['tasks'])
    print('PASS custom-format restore, read-only snapshot, corrupt archive rejection, previous snapshot retention and staging cleanup')
finally:
    job.drop_managed(job.target)
    scratch_state.cleanup()
