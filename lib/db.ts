import { Pool } from 'pg'

const globalForPg = globalThis as unknown as { pgPool: Pool | undefined }

export const pool =
  globalForPg.pgPool ??
  new Pool({
    host: 'localhost',
    port: 5432,
    database: 'gantt_app', // 修正数据库名称
    user: 'postgres',
    password: '11111a',
    // 设置时区为UTC，避免日期转换问题
    timezone: 'UTC',
  })

if (process.env.NODE_ENV !== 'production') {
  globalForPg.pgPool = pool
}

export default pool
