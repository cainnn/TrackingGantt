/**
 * 确保 tasks 表有 auto_schedule 列，并设置默认值
 * 运行: npx tsx scripts/add-auto-schedule.ts
 */
import { Pool } from 'pg'

const pool = new Pool({
  host: 'localhost',
  port: 5432,
  database: 'gantt_db',
  user: 'postgres',
  password: '11111a',
})

async function main() {
  const client = await pool.connect()
  try {
    await client.query(`
      ALTER TABLE tasks ADD COLUMN IF NOT EXISTS auto_schedule BOOLEAN DEFAULT true NOT NULL;
    `)
    console.log('auto_schedule column ready')
  } finally {
    client.release()
    await pool.end()
  }
}

main().catch(console.error)
