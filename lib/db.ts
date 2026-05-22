import { Pool, types } from 'pg'

// 覆盖 pg 的 DATE 类型解析器（OID 1082）：直接返回 YYYY-MM-DD 字符串，
// 避免 Date 对象经 JSON.stringify → toISOString() 时因 UTC 偏移导致日期偏移一天
types.setTypeParser(1082, (val: string) => val)

// 同样覆盖 TIMESTAMP WITHOUT TIME ZONE (OID 1114)：把 'YYYY-MM-DD HH:MM:SS' 改成
// 'YYYY-MM-DDTHH:MM:SS' 的 ISO 形式（不带 Z）原样返回。
// 默认解析器会把无时区的 timestamp 当成 Node 本地 TZ 转成 Date，再经 JSON.stringify
// 走 UTC ISO，导致东八区里 00:00 的任务被序列化成前一天 16:00 → 前端切片后显示
// 少一天。直接给字符串就避开这条 Date 转 UTC 的回路。
types.setTypeParser(1114, (val: string) => (val ? val.replace(' ', 'T') : val))

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
