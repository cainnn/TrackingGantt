#!/usr/bin/env python3
"""Refresh queryable day-1/day-7 PostgreSQL snapshots without restoring into production."""

import argparse
import fcntl
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import datetime, timedelta
from uuid import uuid4
from zoneinfo import ZoneInfo


def identifier(value):
    if not re.fullmatch(r"[a-z_][a-z0-9_]{0,36}", value):
        raise ValueError("DB_NAME must be a lowercase PostgreSQL identifier of at most 37 characters")
    return value


def archive_date(path, source):
    match = re.fullmatch(re.escape(source) + r"_(\d{8})_(\d{6})\.(?:sql\.gz|dump)", path.name)
    if not match:
        return None
    try:
        return datetime.strptime("".join(match.groups()), "%Y%m%d%H%M%S")
    except ValueError:
        return None


def select_archive(directories, source, target_date):
    candidates = []
    for directory in directories:
        for path in directory.glob(f"{source}_*"):
            captured = archive_date(path, source)
            if captured and captured.date() == target_date and path.is_file() and path.stat().st_size:
                candidates.append((captured, str(path), path))
    if not candidates:
        raise FileNotFoundError(f"No snapshot for {target_date}; refusing to substitute another date")
    return max(candidates)[2]


def checksum(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def log(message):
    print(f"{datetime.now().astimezone().isoformat(timespec='seconds')} {message}", flush=True)


class HistoryBackup:
    def __init__(self, slot):
        self.source = identifier(os.environ.get("DB_NAME", "gantt_app"))
        self.slot = slot
        self.days = {"day1": 1, "day7": 7}[slot]
        self.target = f"{self.source}_backup_{slot}"
        self.marker = f"gantt-history:v1:source={self.source}:slot={slot}"
        self.backups = Path(os.environ.get("BACKUP_DIR", "/var/backups/gantt-app"))
        self.history = self.backups / "history"
        self.state = Path(os.environ.get("STATE_DIR", "/var/lib/gantt-db-history"))
        self.timezone = ZoneInfo(os.environ.get("APP_TIME_ZONE", "Asia/Shanghai"))
        self.now = datetime.now(self.timezone)
        self.pg_env = {key: value for key, value in os.environ.items() if not key.startswith("PG")}
        self.pg_env.update({"PGHOST": "/var/run/postgresql", "PGPORT": os.environ.get("DB_PORT", "5432"),
                            "PGAPPNAME": f"gantt-history-{slot}"})

    def pg(self, command, *, stdin=None):
        return subprocess.run(["runuser", "-u", "postgres", "--", *command], env=self.pg_env,
                              stdin=stdin, stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=True).stdout.decode().strip()

    def sql(self, statement, database="postgres"):
        return self.pg(["psql", "-X", "--no-password", "-v", "ON_ERROR_STOP=1", "-At", "-d", database, "-c", statement])

    def database_marker(self, name):
        # All database names here are constructed from validated identifiers and UUID hex.
        value = self.sql(f"SELECT json_build_object('comment', shobj_description(oid, 'pg_database')) "
                         f"FROM pg_database WHERE datname = '{name}'")
        return json.loads(value) if value else None

    def drop_managed(self, name):
        if name == self.source:
            raise RuntimeError("Refusing to drop the production database")
        existing = self.database_marker(name)
        if existing is None:
            return
        if existing["comment"] != self.marker:
            raise RuntimeError(f"Refusing to drop unmanaged database {name}")
        self.sql(f'DROP DATABASE "{name}" WITH (FORCE)')

    def capture(self):
        destination = self.history / f"{self.source}_{self.now:%Y%m%d_%H%M%S}.dump"
        if destination.exists():
            raise FileExistsError(destination)
        partial = destination.with_suffix(".dump.partial")
        log(f"Capturing {self.source} -> {destination}")
        try:
            with partial.open("xb") as output:
                subprocess.run(["runuser", "-u", "postgres", "--", "pg_dump", "--no-password", "-Fc",
                                "--no-owner", "--no-privileges", "--lock-wait-timeout=60s", "-d", self.source],
                               env=self.pg_env, stdout=output, stderr=subprocess.PIPE, check=True)
                output.flush()
                os.fsync(output.fileno())
            with partial.open("rb") as stream:
                self.pg(["pg_restore", "--list"], stdin=stream)
            partial.rename(destination)
            return destination
        finally:
            partial.unlink(missing_ok=True)

    def counts(self, database):
        tables = json.loads(self.sql("SELECT coalesce(json_agg(tablename ORDER BY tablename), '[]') "
                                    "FROM pg_tables WHERE schemaname = 'public'", database))
        if not {"users", "projects", "tasks"}.issubset(tables):
            raise RuntimeError(f"Snapshot is missing required application tables: {tables}")
        counts = {}
        for table in tables:
            quoted = '"' + table.replace('"', '""') + '"'
            counts[table] = int(self.sql(f"SELECT count(*) FROM public.{quoted}", database))
        return counts

    def restore(self, archive):
        existing = self.database_marker(self.target)
        if existing and existing["comment"] != self.marker:
            raise RuntimeError(f"Refusing to replace existing unmanaged database {self.target}")
        suffix = uuid4().hex[:8]
        staging = f"{self.target}_new_{suffix}"
        previous = f"{self.target}_old_{suffix}"
        digest = checksum(archive)
        activated = False
        verified = False
        try:
            self.pg(["createdb", "--no-password", "--template=template0", staging])
            self.sql(f"COMMENT ON DATABASE \"{staging}\" IS '{self.marker}'")
            log(f"Restoring {archive.name} into staging database {staging}")
            if archive.name.endswith(".sql.gz"):
                # Finish CRC validation before sending any SQL to PostgreSQL.
                with tempfile.TemporaryFile() as plain:
                    with gzip.open(archive, "rb") as compressed:
                        shutil.copyfileobj(compressed, plain)
                    plain.seek(0)
                    self.pg(["psql", "-X", "--no-password", "--single-transaction", "-v", "ON_ERROR_STOP=1",
                             "-d", staging], stdin=plain)
            else:
                with archive.open("rb") as stream:
                    self.pg(["pg_restore", "--no-password", "--exit-on-error", "--single-transaction", "--no-owner",
                             "--no-privileges", "-d", staging], stdin=stream)
            counts = self.counts(staging)
            metadata = {"slot": self.slot, "database": self.target, "source_database": self.source,
                        "archive": str(archive), "sha256": digest,
                        "snapshot_at": archive_date(archive, self.source).replace(tzinfo=self.timezone).isoformat(),
                        "restored_at": datetime.now(self.timezone).isoformat(), "tables": counts}
            payload = json.dumps(metadata, ensure_ascii=False).replace("'", "''")
            self.sql("CREATE SCHEMA backup_metadata; CREATE TABLE backup_metadata.snapshot (details jsonb NOT NULL); "
                     f"INSERT INTO backup_metadata.snapshot VALUES ('{payload}'::jsonb)", staging)
            self.sql(f'ALTER DATABASE "{staging}" SET default_transaction_read_only = on')
            statements = ["BEGIN", "SET LOCAL lock_timeout = '15s'", "SET LOCAL statement_timeout = '60s'"]
            if existing:
                statements.extend([f'ALTER DATABASE "{self.target}" ALLOW_CONNECTIONS false',
                                   f"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '{self.target}'",
                                   f'ALTER DATABASE "{self.target}" RENAME TO "{previous}"'])
            statements.extend([f'ALTER DATABASE "{staging}" RENAME TO "{self.target}"', "COMMIT"])
            self.sql("; ".join(statements))
            activated = True
            assert self.counts(self.target) == counts, "Published snapshot failed verification"
            verified = True
            state_file = self.state / f"{self.slot}.json"
            temporary = state_file.with_suffix(".json.partial")
            temporary.write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n")
            temporary.replace(state_file)
            if existing:
                self.drop_managed(previous)
            log(f"SUCCESS {self.target}: snapshot={metadata['snapshot_at']}, tables={len(counts)}, tasks={counts['tasks']}")
            return metadata
        except Exception:
            if activated and existing and not verified:
                # Put the last good queryable snapshot back if post-publish validation fails.
                self.sql(f'BEGIN; ALTER DATABASE "{self.target}" RENAME TO "{staging}"; '
                         f'ALTER DATABASE "{previous}" RENAME TO "{self.target}"; '
                         f'ALTER DATABASE "{self.target}" ALLOW_CONNECTIONS true; COMMIT')
            raise
        finally:
            self.drop_managed(staging)

    def run(self):
        for directory in [self.history, self.state]:
            directory.mkdir(parents=True, exist_ok=True, mode=0o700)
        # The two 03:00 jobs serialize their IO and catalog changes on the same server.
        with open("/run/lock/gantt-db-history.lock", "a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            if self.slot == "day1":
                self.capture()
            archive = select_archive([self.history, self.backups], self.source, (self.now - timedelta(days=self.days)).date())
            self.restore(archive)
            if self.slot == "day1":
                # Only prune archives created by this job; deployment/legacy backups are retained.
                cutoff = (self.now - timedelta(days=14)).date()
                for path in self.history.glob(f"{self.source}_*.dump"):
                    captured = archive_date(path, self.source)
                    if captured and captured.date() < cutoff:
                        path.unlink()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("slot", choices=["day1", "day7"])
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise PermissionError("Run as root; PostgreSQL commands use local peer authentication as postgres")
    os.umask(0o077)
    HistoryBackup(args.slot).run()


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        log(f"FAILED: {error}")
        if isinstance(error, subprocess.CalledProcessError):
            print(error.stderr.decode(errors="replace"), file=sys.stderr)
        sys.exit(1)
