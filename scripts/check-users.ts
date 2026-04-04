import { Pool } from 'pg'

const pool = new Pool({ host: 'localhost', port: 5432, database: 'gantt_db', user: 'postgres', password: process.env.DB_PASSWORD || '' })

async function main() {
  const r = await pool.query('SELECT id, username, email, created_at FROM users')
  console.log('Users in DB:', r.rows.length)
  console.log(JSON.stringify(r.rows, null, 2))
  await pool.end()
}

main().catch(console.error)
