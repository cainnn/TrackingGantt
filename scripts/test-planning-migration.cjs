const {Pool} = require('pg');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');

const host = process.env.DB_HOST || 'localhost';
if (!['localhost', '127.0.0.1', '::1'].includes(host)) throw new Error('Migration tests require a local database');
const pool = new Pool({host, port: Number(process.env.DB_PORT || 5432), user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD, database: process.env.DB_NAME || 'gantt_app'});
const sql = fs.readFileSync(path.join(__dirname, 'migrate-project-planning-status.sql'), 'utf8');

async function testMigration(previousAllStable) {
  const client = await pool.connect();
  try {
    // Temporary tables shadow application tables; no production or local user data is changed.
    await client.query(`CREATE TEMP TABLE projects (id integer PRIMARY KEY, status_date timestamp
      ${previousAllStable ? ", planning_status varchar(10) NOT NULL DEFAULT 'stable'" : ''})`);
    await client.query(`CREATE TEMP TABLE tasks (id integer PRIMARY KEY, project_id integer, parent_id integer,
      is_deleted boolean DEFAULT false, duration numeric, percent_done numeric, start_date timestamp, end_date timestamp)`);
    await client.query('CREATE TEMP TABLE app_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT NOW())');
    await client.query(`INSERT INTO projects (id, status_date) VALUES
      (1, NULL), (2, NULL), (3, NULL), (4, NULL),
      (5, '2026-01-06'), (6, '2026-01-05'), (7, NULL),
      (8, '2026-01-01 11:15'), (9, '2026-01-01 11:30'),
      (10, '2025-12-31'), (11, NULL), (12, NULL), (13, NULL), (14, NULL)`);
    await client.query(`INSERT INTO tasks (id, project_id, parent_id, is_deleted, duration, percent_done, start_date, end_date) VALUES
      (2, 2, NULL, false, 14400, 49, '2026-01-01', '2026-01-11'),
      (3, 3, NULL, false, 14400, 50, '2026-01-01', '2026-01-11'),
      (4, 4, NULL, false, 14400, 80, '2026-01-01', '2026-01-11'),
      (5, 5, NULL, false, 14400, 99, '2026-01-01', '2026-01-11'),
      (6, 6, NULL, false, 14400, 99, '2026-01-01', '2026-01-11'),
      (70, 7, NULL, false, 999999, 0, '2026-01-01', '2026-01-11'),
      (71, 7, 70, false, 1440, 0, '2026-01-01', '2026-01-02'),
      (72, 7, 70, false, 4320, 100, '2026-01-02', '2026-01-05'),
      (73, 7, NULL, true, 999999, 0, '2026-01-01', '2026-01-11'),
      (8, 8, NULL, false, 60, 100, '2026-01-01 11:00', '2026-01-01 12:00'),
      (9, 9, NULL, false, 60, 0, '2026-01-01 11:00', '2026-01-01 12:00'),
      (10, 10, NULL, false, 14400, 100, '2026-01-01', '2026-01-11'),
      (11, 11, NULL, false, 14400, 49.6, '2026-01-01', '2026-01-11'),
      (12, 12, NULL, false, 14400, 49.4, '2026-01-01', '2026-01-11'),
      (13, 13, NULL, false, 0, 100, '2026-01-01', '2026-01-01'),
      (14, 14, NULL, false, 14400, 100, NULL, NULL)`);
    await client.query(sql);
    const stable = new Set([3, 4, 5, 7, 9, 11]);
    const actual = (await client.query('SELECT id, planning_status FROM projects ORDER BY id')).rows;
    assert.equal(actual.length, 14);
    for (const row of actual) assert.equal(row.planning_status, stable.has(row.id) ? 'stable' : 'draft', `project ${row.id}`);
    assert.equal((await client.query("SELECT count(*)::int AS n FROM app_migrations WHERE name='project-planning-status-by-progress-v1'")).rows[0].n, 1);
    await client.query("UPDATE projects SET planning_status='draft' WHERE id=3");
    await client.query("UPDATE projects SET planning_status='stable' WHERE id=2");
    await client.query('INSERT INTO projects (id) VALUES (15)');
    await client.query(sql);
    const repeated = (await client.query('SELECT id, planning_status FROM projects WHERE id IN (2, 3, 15) ORDER BY id')).rows;
    assert.deepEqual(repeated, [{id: 2, planning_status: 'stable'}, {id: 3, planning_status: 'draft'}, {id: 15, planning_status: 'draft'}]);
    console.log(`PASS ${previousAllStable ? 'previous all-stable schema' : 'initial schema'}: 14 progress cases; new draft default; reruns preserve chosen states`);
  } finally {
    client.release(true);
  }
}
(async () => {
  await testMigration(false);
  await testMigration(true);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => pool.end());
