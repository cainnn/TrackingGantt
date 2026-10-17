const { loadEnvConfig } = require('@next/env');
const { Pool } = require('pg');
const fs = require('node:fs');
const path = require('node:path');

loadEnvConfig(process.cwd());
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  database: process.env.DB_NAME || 'gantt_app',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
});

async function main() {
  try {
    await pool.query(fs.readFileSync(path.join(__dirname, 'migrate-project-memberships.sql'), 'utf8'));
    console.log('用户项目关联迁移完成，root 管理员已就绪。');
  } finally {
    await pool.end();
  }
}
main().catch(error => { console.error('用户项目关联迁移失败:', error.message); process.exitCode = 1; });
