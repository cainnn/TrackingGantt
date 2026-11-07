const { Pool } = require('pg');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const pool = new Pool({ host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || 'gantt_app', user: process.env.DB_USER || 'postgres', password: process.env.DB_PASSWORD });
(async () => {
  try {
    await pool.query(readFileSync(join(__dirname, 'migrate-task-custom-fields.sql'), 'utf8'));
    console.log('Task custom field migration completed');
  } finally { await pool.end(); }
})().catch(err => { console.error(err.message); process.exitCode = 1; });
