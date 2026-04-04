import { Pool, types } from 'pg'

// 覆盖 pg 的 DATE 类型解析器（OID 1082）：直接返回 YYYY-MM-DD 字符串，
// 避免 Date 对象经 JSON.stringify → toISOString() 时因 UTC 偏移导致日期偏移一天
types.setTypeParser(1082, (val: string) => val)

const globalForPg = globalThis as unknown as { pgPool: Pool | undefined }

function envInt(name: string, fallback: number): number {
  const v = process.env[name]
  if (!v) return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

export const pool =
  globalForPg.pgPool ??
  new Pool({
    host: process.env.DB_HOST ?? 'localhost',
    port: envInt('DB_PORT', 5432),
    database: process.env.DB_NAME ?? 'gantt_app',
    user: process.env.DB_USER ?? 'postgres',
    password: process.env.DB_PASSWORD ?? '',
    max: envInt('DB_POOL_MAX', 20),
    idleTimeoutMillis: envInt('DB_IDLE_TIMEOUT_MS', 30000),
    connectionTimeoutMillis: envInt('DB_CONNECT_TIMEOUT_MS', 5000),
    options: [
      `-c statement_timeout=${envInt('DB_STATEMENT_TIMEOUT_MS', 15000)}`,
      `-c lock_timeout=${envInt('DB_LOCK_TIMEOUT_MS', 5000)}`,
      `-c idle_in_transaction_session_timeout=${envInt('DB_TX_IDLE_TIMEOUT_MS', 15000)}`,
    ].join(' '),
  })

if (process.env.NODE_ENV !== 'production') {
  globalForPg.pgPool = pool
}

export default pool
