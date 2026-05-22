/**
 * 天级项目时间对齐脚本：把所有 time_granularity != 'minute' 项目里
 * 带非整天时分秒的任务 snap 到 00:00，duration 圆整为整天 (× 1440 分钟)。
 *
 * 不会跑级联/摘要重算 —— snap 后下次打开项目时 API GET 的一致性自检
 * 会自动触发 cascade + updateSummaryTasksDates 把上下游收口。
 *
 * 用法：
 *   # 干跑（默认）：只打印每个项目里有多少需要 snap，不写库
 *   node scripts/snap-day-projects.js
 *
 *   # 实际写库
 *   node scripts/snap-day-projects.js --apply
 *
 *   # 只处理某个项目
 *   node scripts/snap-day-projects.js --project=<projectId> --apply
 *
 *   # VPS：用环境变量指定连接（默认本地 gantt_app）
 *   DB_HOST=... DB_PORT=... DB_NAME=... DB_USER=... DB_PASSWORD=... \
 *   node scripts/snap-day-projects.js --apply
 */
const { Pool, types } = require('pg')

// 与 lib/db.ts 一致：DATE 类型直接返回字符串，避免 UTC 漂移
types.setTypeParser(1082, v => v)

function envInt(name, fallback) {
  const v = process.env[name]
  if (!v) return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: envInt('DB_PORT', 5432),
  database: process.env.DB_NAME || 'gantt_app',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || '',
})

const argv = process.argv.slice(2)
const apply = argv.includes('--apply')
const verbose = argv.includes('--verbose') || argv.includes('-v')
const projectFilter = (() => {
  const a = argv.find(x => x.startsWith('--project='))
  return a ? a.slice('--project='.length) : null
})()

const pad = n => String(n).padStart(2, '0')

/** pg 返回的 timestamp 是 Date 对象。把它格式化为本地 'YYYY-MM-DDTHH:mm:00'。 */
function toLocalDtStr(d) {
  if (d == null) return null
  if (typeof d === 'string') return d.length >= 16 ? `${d.slice(0, 10)}T${d.slice(11, 16)}:00` : null
  if (!(d instanceof Date) || isNaN(d.getTime())) return null
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
         `T${pad(d.getHours())}:${pad(d.getMinutes())}:00`
}

/** start_date floor 到当天 00:00，duration 圆整到整天，end = start + duration */
function snapTaskFields(row) {
  const s = row.start_date instanceof Date ? new Date(row.start_date) : null
  if (!s) return null
  const srcDur = (row.duration != null && Number.isFinite(Number(row.duration)))
    ? Number(row.duration)
    : null
  // 缺 duration 时，从 end - start 推算（分钟）
  const e = row.end_date instanceof Date ? new Date(row.end_date) : null
  const fallbackDur = (s && e) ? Math.round((e.getTime() - s.getTime()) / 60000) : 0
  const baseDur = srcDur != null ? srcDur : fallbackDur
  const days = Math.max(0, Math.round(baseDur / 1440))
  const newDur = days * 1440
  s.setHours(0, 0, 0, 0)
  const newStart = toLocalDtStr(s)
  const newEnd = (() => {
    const d = new Date(s)
    d.setMinutes(d.getMinutes() + newDur)
    return toLocalDtStr(d)
  })()
  return { newStart, newEnd, newDur }
}

async function processProject(client, project) {
  const { id, name, time_granularity } = project
  const res = await client.query(
    `SELECT id, task_code, name, start_date, end_date, duration FROM tasks
     WHERE project_id = $1 AND is_deleted = false
       AND start_date IS NOT NULL AND end_date IS NOT NULL
       AND (
         EXTRACT(HOUR   FROM start_date) <> 0
         OR EXTRACT(MINUTE FROM start_date) <> 0
         OR EXTRACT(SECOND FROM start_date) <> 0
         OR EXTRACT(HOUR   FROM end_date) <> 0
         OR EXTRACT(MINUTE FROM end_date) <> 0
         OR EXTRACT(SECOND FROM end_date) <> 0
         OR (duration IS NOT NULL AND duration % 1440 <> 0)
       )
     ORDER BY order_index ASC`,
    [id],
  )
  if (res.rows.length === 0) {
    console.log(`  [${time_granularity}] ${name} (${id}): 已对齐`)
    return { project: id, touched: 0 }
  }
  console.log(`  [${time_granularity}] ${name} (${id}): 待修正 ${res.rows.length} 条`)
  let touched = 0
  for (const row of res.rows) {
    const snap = snapTaskFields(row)
    if (!snap) continue
    const oldStart = toLocalDtStr(row.start_date)
    const oldEnd = toLocalDtStr(row.end_date)
    if (verbose) {
      console.log(
        `    - ${row.task_code ?? ''} ${row.name}: ` +
        `${oldStart} → ${snap.newStart} | ${oldEnd} → ${snap.newEnd} | ` +
        `dur ${row.duration} → ${snap.newDur}`
      )
    }
    if (apply) {
      await client.query(
        `UPDATE tasks SET start_date = $1, end_date = $2, duration = $3, updated_at = NOW()
         WHERE id = $4`,
        [snap.newStart, snap.newEnd, snap.newDur, row.id],
      )
    }
    touched++
  }
  return { project: id, touched }
}

async function main() {
  const mode = apply ? 'APPLY' : 'DRY-RUN'
  console.log(`▸ snap-day-projects [${mode}]  db=${process.env.DB_NAME || 'gantt_app'}@${process.env.DB_HOST || 'localhost'}`)
  if (!apply) console.log('  （加 --apply 才会真正写库）')

  const projQuery = projectFilter
    ? `SELECT id, name, time_granularity FROM projects
       WHERE id = $1 AND COALESCE(time_granularity, 'day') <> 'minute'`
    : `SELECT id, name, time_granularity FROM projects
       WHERE COALESCE(time_granularity, 'day') <> 'minute'
       ORDER BY created_at`
  const projRes = await pool.query(projQuery, projectFilter ? [projectFilter] : [])
  if (projRes.rows.length === 0) {
    console.log('  没有天级项目（或过滤后为空）')
    return
  }
  console.log(`  天级项目：${projRes.rows.length} 个`)

  const client = await pool.connect()
  const summary = []
  try {
    if (apply) await client.query('BEGIN')
    for (const p of projRes.rows) {
      const r = await processProject(client, p)
      summary.push({ ...r, name: p.name })
    }
    if (apply) await client.query('COMMIT')
  } catch (err) {
    if (apply) await client.query('ROLLBACK').catch(() => {})
    console.error('✗ 失败，事务回滚：', err.message)
    process.exitCode = 1
  } finally {
    client.release()
  }

  const total = summary.reduce((a, b) => a + b.touched, 0)
  console.log('—'.repeat(60))
  console.log(`▸ 完成：${apply ? '已写库' : '未写库 (dry-run)'}，共 ${total} 条任务待 snap`)
  for (const s of summary) {
    if (s.touched > 0) console.log(`  · ${s.name}: ${s.touched}`)
  }
}

main()
  .catch(err => { console.error(err); process.exitCode = 1 })
  .finally(() => pool.end())
