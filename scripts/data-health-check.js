#!/usr/bin/env node
const { Pool, types } = require('pg');

types.setTypeParser(1082, (val) => val);
types.setTypeParser(1114, (val) => (val ? val.replace(' ', 'T') : val));

function envInt(name, fallback) {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: envInt('DB_PORT', 5432),
  database: process.env.DB_NAME || 'gantt_app',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
  connectionTimeoutMillis: envInt('DB_CONNECT_TIMEOUT_MS', 5000),
});

const LIMIT = envInt('HEALTH_LIMIT', 50);

function printRows(title, rows, columns) {
  console.log(`\n${title}`);
  console.log('-'.repeat(title.length));
  if (rows.length === 0) {
    console.log('OK');
    return;
  }
  for (const row of rows) {
    const parts = columns.map((c) => `${c}: ${row[c] ?? ''}`);
    console.log(`- ${parts.join(' | ')}`);
  }
  if (rows.length >= LIMIT) {
    console.log(`... only first ${LIMIT} rows shown; set HEALTH_LIMIT to change this.`);
  }
}

async function main() {
  const client = await pool.connect();
  try {
    const dayDurationMismatch = await client.query(`
      SELECT p.name AS project, t.task_code, t.name AS task_name,
             t.start_date, t.end_date, t.duration,
             GREATEST(0, ROUND(EXTRACT(EPOCH FROM (t.end_date - t.start_date)) / 86400.0)::int * 1440) AS expected_duration
        FROM tasks t
        JOIN projects p ON p.id = t.project_id
       WHERE t.is_deleted = false
         AND COALESCE(p.time_granularity, 'day') <> 'minute'
         AND COALESCE(t.is_milestone, false) = false
         AND t.start_date IS NOT NULL
         AND t.end_date IS NOT NULL
         AND t.duration IS DISTINCT FROM GREATEST(0, ROUND(EXTRACT(EPOCH FROM (t.end_date - t.start_date)) / 86400.0)::int * 1440)
       ORDER BY p.name, t.task_code
       LIMIT $1
    `, [LIMIT]);

    const zeroDurationWithSpan = await client.query(`
      SELECT p.name AS project, t.task_code, t.name AS task_name,
             t.start_date, t.end_date, t.duration
        FROM tasks t
        JOIN projects p ON p.id = t.project_id
       WHERE t.is_deleted = false
         AND COALESCE(t.is_milestone, false) = false
         AND t.start_date IS NOT NULL
         AND t.end_date IS NOT NULL
         AND t.end_date <> t.start_date
         AND COALESCE(t.duration, 0) = 0
       ORDER BY p.name, t.task_code
       LIMIT $1
    `, [LIMIT]);

    const duplicateActiveCodes = await client.query(`
      SELECT p.name AS project, t.task_code, COUNT(*)::int AS count
        FROM tasks t
        JOIN projects p ON p.id = t.project_id
       WHERE t.is_deleted = false
         AND t.task_code IS NOT NULL
       GROUP BY p.name, t.project_id, t.task_code
      HAVING COUNT(*) > 1
       ORDER BY p.name, t.task_code
       LIMIT $1
    `, [LIMIT]);

    const activeDeletedCodeMix = await client.query(`
      SELECT p.name AS project, t.task_code,
             COUNT(*) FILTER (WHERE t.is_deleted = false)::int AS active_count,
             COUNT(*) FILTER (WHERE t.is_deleted = true)::int AS deleted_count
        FROM tasks t
        JOIN projects p ON p.id = t.project_id
       WHERE t.task_code IS NOT NULL
       GROUP BY p.name, t.project_id, t.task_code
      HAVING COUNT(*) FILTER (WHERE t.is_deleted = false) > 0
         AND COUNT(*) FILTER (WHERE t.is_deleted = true) > 0
       ORDER BY p.name, t.task_code
       LIMIT $1
    `, [LIMIT]);

    const checks = [
      {
        title: 'Day-level duration mismatches',
        rows: dayDurationMismatch.rows,
        columns: ['project', 'task_code', 'task_name', 'start_date', 'end_date', 'duration', 'expected_duration'],
      },
      {
        title: 'Non-milestone zero-duration tasks with date span',
        rows: zeroDurationWithSpan.rows,
        columns: ['project', 'task_code', 'task_name', 'start_date', 'end_date', 'duration'],
      },
      {
        title: 'Duplicate active task codes within a project',
        rows: duplicateActiveCodes.rows,
        columns: ['project', 'task_code', 'count'],
      },
      {
        title: 'Task codes shared by active and soft-deleted tasks',
        rows: activeDeletedCodeMix.rows,
        columns: ['project', 'task_code', 'active_count', 'deleted_count'],
      },
    ];

    console.log('Data health check');
    console.log(`Database: ${process.env.DB_NAME || 'gantt_app'} @ ${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || '5432'}`);
    console.log(`Limit per check: ${LIMIT}`);

    let issueCount = 0;
    for (const check of checks) {
      issueCount += check.rows.length;
      printRows(check.title, check.rows, check.columns);
    }

    console.log(`\nTotal issue rows: ${issueCount}`);
    if (issueCount > 0) process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(async (err) => {
  console.error('Data health check failed:', err.message);
  await pool.end().catch(() => {});
  process.exit(2);
});
