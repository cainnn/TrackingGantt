const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { Pool } = require('pg');
const host = process.env.DB_HOST || 'localhost';
if (!['localhost', '127.0.0.1', '::1'].includes(host)) throw new Error('Use a local database for migration tests');
const pool = new Pool({ host, port: Number(process.env.DB_PORT || 5432), database: process.env.DB_NAME || 'gantt_app',
  user: process.env.DB_USER || 'postgres', password: process.env.DB_PASSWORD });
const schema = 'gantt_start_test_' + randomUUID().replaceAll('-', '');
const sql = readFileSync(join(__dirname, 'migrate-project-start-from-tasks.sql'), 'utf8');
let client;
(async () => {
  client = await pool.connect();
  await client.query(`CREATE SCHEMA ${schema}`); await client.query(`SET search_path TO ${schema}`);
  await client.query('CREATE TABLE projects (id uuid PRIMARY KEY, start_date date)');
  await client.query('CREATE TABLE tasks (id uuid PRIMARY KEY, project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE, start_date timestamp, is_deleted boolean DEFAULT false)');
  const [a, b, empty] = Array.from({ length: 3 }, randomUUID), [first, second, deleted] = Array.from({ length: 3 }, randomUUID);
  for (const id of [a, b, empty]) await client.query("INSERT INTO projects VALUES ($1, '2026-11-06')", [id]);
  await client.query("INSERT INTO tasks VALUES ($1,$4,'2026-08-10',false),($2,$4,'2026-08-18',false),($3,$4,'2020-01-01',true)", [first, second, deleted, a]);
  const before = (await client.query('SELECT * FROM tasks ORDER BY id')).rows;
  await client.query(sql);
  const start = async id => (await client.query("SELECT to_char(start_date,'YYYY-MM-DD HH24:MI') AS value FROM projects WHERE id=$1", [id])).rows[0].value;
  assert.equal(await start(a), '2026-08-10 00:00'); assert.equal(await start(empty), null);
  assert.deepEqual((await client.query('SELECT * FROM tasks ORDER BY id')).rows, before);
  await client.query(sql); assert.equal(await start(a), '2026-08-10 00:00');
  await client.query("UPDATE projects SET start_date='2030-01-01' WHERE id=$1", [a]); assert.equal(await start(a), '2026-08-10 00:00');
  await client.query("UPDATE tasks SET start_date='2026-08-20 09:35' WHERE id=$1", [first]); assert.equal(await start(a), '2026-08-18 00:00');
  await client.query('UPDATE tasks SET is_deleted=true WHERE id=$1', [second]); assert.equal(await start(a), '2026-08-20 09:35');
  await client.query('UPDATE tasks SET is_deleted=false WHERE id=$1', [second]); assert.equal(await start(a), '2026-08-18 00:00');
  await client.query('UPDATE tasks SET project_id=$1 WHERE id=$2', [b, second]);
  assert.equal(await start(a), '2026-08-20 09:35'); assert.equal(await start(b), '2026-08-18 00:00');
  await client.query('BEGIN'); await client.query("UPDATE tasks SET start_date='2025-01-01' WHERE id=$1", [first]);
  assert.equal(await start(a), '2025-01-01 00:00'); await client.query('ROLLBACK'); assert.equal(await start(a), '2026-08-20 09:35');
  await client.query('DELETE FROM tasks WHERE id=$1', [first]); assert.equal(await start(a), null);
  await client.query('UPDATE tasks SET start_date=NULL WHERE id=$1', [second]); assert.equal(await start(b), null);
  const other = await pool.connect();
  try {
    await other.query(`SET search_path TO ${schema}`);
    await client.query('BEGIN'); await client.query("INSERT INTO tasks VALUES ($1,$2,'2026-08-14 09:35',false)", [randomUUID(), empty]);
    const pending = other.query("INSERT INTO tasks VALUES ($1,$2,'2026-08-14 08:14',false)", [randomUUID(), empty]);
    await client.query('COMMIT'); await pending;
    assert.equal(await start(empty), '2026-08-14 08:14');
  } finally { other.release(true); }
  await client.query('DELETE FROM projects WHERE id=$1', [empty]);
  console.log('PASS isolated database migration: backfill, idempotency, unchanged task dates, minute precision, update/delete/restore/move, rollback, concurrent inserts and cascade cleanup');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (client) { await client.query('ROLLBACK').catch(() => {}); await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); client.release(true); }
  await pool.end();
});
