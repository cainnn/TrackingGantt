import importlib.util
from pathlib import Path
import tempfile
import unittest
from datetime import date
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('history', Path(__file__).with_name('db-history-backup.py'))
history = importlib.util.module_from_spec(spec)
spec.loader.exec_module(history)


class BackupSelectionTest(unittest.TestCase):
    def test_exact_calendar_date_and_latest_backup_across_formats(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ['gantt_app_20261111_030001.sql.gz', 'gantt_app_20261111_040001.dump',
                         'gantt_app_20261112_030001.dump', 'gantt_app_20261111_050001.dump.partial',
                         'other_20261111_060001.dump', 'gantt_app_20261111_070001.dump']:
                (root / name).write_bytes(b'' if '070001' in name else b'archive')
            self.assertEqual(history.select_archive([root], 'gantt_app', date(2026, 11, 11)).name,
                             'gantt_app_20261111_040001.dump')

    def test_missing_day_is_not_replaced_with_newer_or_older_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'gantt_app_20261112_030001.sql.gz').write_bytes(b'archive')
            with self.assertRaises(FileNotFoundError):
                history.select_archive([root], 'gantt_app', date(2026, 11, 5))

    def test_calendar_boundaries_and_invalid_names(self):
        self.assertIsNone(history.archive_date(Path('gantt_app_20260230_030001.dump'), 'gantt_app'))
        self.assertIsNone(history.archive_date(Path('gantt_app_20261111_250001.dump'), 'gantt_app'))
        with patch.dict('os.environ', {'DB_NAME': 'gantt_app'}):
            job = history.HistoryBackup('day7')
            self.assertNotEqual(job.source, job.target)
            self.assertEqual(job.days, 7)
        for name in ['gantt_app; DROP DATABASE postgres', 'postgres-db', 'a' * 38]:
            with self.assertRaises(ValueError):
                history.identifier(name)
        self.assertLessEqual(len(history.identifier('a' * 37) + '_backup_day1_new_12345678'), 63)

    def test_never_drop_production_or_unmanaged_database(self):
        job = history.HistoryBackup('day1')
        with self.assertRaisesRegex(RuntimeError, 'production'):
            job.drop_managed(job.source)
        with patch.object(job, 'database_marker', return_value={'comment': None}), patch.object(job, 'sql') as sql:
            with self.assertRaisesRegex(RuntimeError, 'unmanaged'):
                job.drop_managed(job.target)
            sql.assert_not_called()

    def test_database_ownership_marker_uses_shared_catalog_comments(self):
        job = history.HistoryBackup('day1')
        with patch.object(job, 'sql', return_value='{"comment":"managed"}') as sql:
            self.assertEqual(job.database_marker(job.target), {'comment': 'managed'})
            self.assertIn('shobj_description', sql.call_args.args[0])


if __name__ == '__main__':
    unittest.main()
