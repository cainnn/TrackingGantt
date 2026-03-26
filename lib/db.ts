import { Pool } from 'pg'

const globalForPg = globalThis as unknown as { pgPool: Pool | undefined }

export const pool =
  globalForPg.pgPool ??
  new Pool({
    host: process.env.DB_HOST || 'localhost',
    port: parseInt(process.env.DB_PORT || '5432'),
    database: process.env.DB_NAME || 'gantt_app',
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || '11111a',
    // 设置时区为UTC，避免日期转换问题
    timezone: 'UTC',
  })

if (process.env.NODE_ENV !== 'production') {
  globalForPg.pgPool = pool
}

export default pool
