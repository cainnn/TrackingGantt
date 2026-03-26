import { Pool } from 'pg'
import bcrypt from 'bcryptjs'

const pool = new Pool({ host: 'localhost', port: 5432, database: 'gantt_db', user: 'postgres', password: '11111a' })

async function main() {
  const passwordHash = await bcrypt.hash('admin123', 10)
  const r = await pool.query(
    `INSERT INTO users (username, email, password_hash)
     VALUES ($1, $2, $3)
     ON CONFLICT (username) DO UPDATE SET password_hash = $3
     RETURNING id, username, email`,
    ['admin', 'admin@gantt.local', passwordHash]
  )
  console.log('Admin user ready:', r.rows[0])
  await pool.end()
}

main().catch(console.error)
