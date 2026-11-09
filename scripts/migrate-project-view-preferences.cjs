const { Pool } = require('pg');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const pool = new Pool({ host: process.env.DB_HOST || 'localhost', port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || 'gantt_app', user: process.env.DB_USER || 'postgres', password: process.env.DB_PASSWORD });
(async () => {
  try {
    await pool.query(readFileSync(join(__dirname, 'migrate-project-view-preferences.sql'), 'utf8'));
    console.log('Project layout migration completed');
  } finally { await pool.end(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
