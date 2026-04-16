import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { getAuthUser, requireWrite } from '@/lib/middleware'
import { success, failure } from '@/lib/result'
import { diffSnapshots, type SnapshotTask } from '@/lib/versionDiff'

type Params = { params: Promise<{ projectId: string }> }

async function verifyOwner(projectId: string, userId: string) {
  const r = await pool.query('SELECT id FROM projects WHERE id = $1 AND user_id = $2', [projectId, userId])
  return r.rows.length > 0
}

// GET /api/versions/[projectId]
// ?list=1  → 返回所有版本列表（不含 snapshot 大字段）
export async function GET(req: NextRequest, { params }: Params) {
  const auth = getAuthUser(req)
  if (!auth.ok) return NextResponse.json(auth, { status: auth.code ?? 401 })
  const { projectId } = await params

  if (auth.value.role !== 'view' && auth.value.role !== 'administrator' && !(await verifyOwner(projectId, auth.value.userId)))
    return NextResponse.json(failure('Not found', 404), { status: 404 })

  const listAll = req.nextUrl.searchParams.get('list')
  const detailId = req.nextUrl.searchParams.get('id')

  // 获取单个版本详情（含 snapshot）
  if (detailId) {
    const res = await pool.query(
      `SELECT id, version_number, name, description, status_date, snapshot, created_by, created_at
       FROM project_versions
       WHERE id = $1 AND project_id = $2`,
      [detailId, projectId],
    )
    if (!res.rows.length) return NextResponse.json(failure('Not found', 404), { status: 404 })
    return NextResponse.json(success(res.rows[0]))
  }

  if (listAll) {
    const res = await pool.query(
      `SELECT v.id, v.version_number, v.name, v.description, v.status_date,
              v.created_by, v.created_at, v.changes,
              (SELECT count(*)::int FROM jsonb_array_elements(v.snapshot->'tasks')) AS task_count
       FROM project_versions v
       WHERE v.project_id = $1
       ORDER BY v.version_number DESC`,
      [projectId],
    )
    return NextResponse.json(success(res.rows))
  }

  return NextResponse.json(success(null))
}

// POST /api/versions/[projectId] — 创建快照
// body: { name?, description?, status_date?, tasks?, dependencies? }
export async function POST(req: NextRequest, { params }: Params) {
  const auth = getAuthUser(req)
  if (!auth.ok) return NextResponse.json(auth, { status: auth.code ?? 401 })
  const writeBlock = requireWrite(auth); if (writeBlock) return writeBlock
  const { projectId } = await params

  if (auth.value.role !== 'administrator' && !(await verifyOwner(projectId, auth.value.userId)))
    return NextResponse.json(failure('Not found', 404), { status: 404 })

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    const body = await req.json().catch(() => ({}))
    const statusDate: string | null = body.status_date ?? null
    const description: string | null = body.description ?? null

    // 禁止保存"未来"日期的版本：状态日期不得超过服务器当前日期
    if (statusDate) {
      const now = new Date()
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
      if (statusDate > today) {
        await client.query('ROLLBACK')
        client.release()
        return NextResponse.json(failure(`状态日期不能晚于今天 (${today})`, 400), { status: 400 })
      }
    }

    // 验证：新状态日期必须严格大于上一版本的状态日期
    const lastRes = await client.query(
      `SELECT id, version_number, status_date, snapshot FROM project_versions
       WHERE project_id = $1 ORDER BY version_number DESC LIMIT 1`,
      [projectId],
    )
    const lastVersion = lastRes.rows[0] ?? null
    if (statusDate && lastVersion?.status_date) {
      const lastSD = typeof lastVersion.status_date === 'string'
        ? lastVersion.status_date.split('T')[0]
        : new Date(lastVersion.status_date).toISOString().split('T')[0]
      if (statusDate < lastSD) {
        await client.query('ROLLBACK')
        client.release()
        return NextResponse.json(failure(`状态日期不能早于上一版本 (${lastSD})`, 400), { status: 400 })
      }
    }

    // 快照数据：优先使用请求体，否则从数据库读取
    let snapshotTasks, snapshotDeps
    if (Array.isArray(body.tasks) && Array.isArray(body.dependencies)) {
      snapshotTasks = body.tasks.filter((t: Record<string, unknown>) => !t.is_deleted)
      snapshotDeps = body.dependencies
    } else {
      const [tRes, dRes] = await Promise.all([
        client.query('SELECT * FROM tasks WHERE project_id = $1 AND is_deleted = false ORDER BY order_index', [projectId]),
        client.query(
          `SELECT d.* FROM dependencies d
           JOIN tasks ft ON ft.id = d.from_task_id AND ft.is_deleted = false
           JOIN tasks tt ON tt.id = d.to_task_id AND tt.is_deleted = false
           WHERE d.project_id = $1`, [projectId]),
      ])
      snapshotTasks = tRes.rows
      snapshotDeps = dRes.rows
    }

    const snapshot = { tasks: snapshotTasks, dependencies: snapshotDeps }

    // 计算与上一版本的差异
    let changes = null
    const reasonMap: Record<string, string> =
      body.reasons && typeof body.reasons === 'object' ? body.reasons : {}
    if (lastVersion) {
      const prevTasks: SnapshotTask[] = lastVersion.snapshot?.tasks ?? []
      const diffs = diffSnapshots(prevTasks, snapshotTasks).map(d => {
        const r = reasonMap[d.task_code]
        return r ? { ...d, reason: r } : d
      })
      changes = {
        diffs,
        stats: {
          added: diffs.filter(d => d.type === 'added').length,
          removed: diffs.filter(d => d.type === 'removed').length,
          changed: diffs.filter(d => d.type === 'changed').length,
        },
      }
    }

    // 同一状态日期只保留一个版本 → 如果已有则替换
    let row
    if (statusDate) {
      const existRes = await client.query(
        `SELECT id, version_number FROM project_versions
         WHERE project_id = $1 AND status_date = $2`,
        [projectId, statusDate],
      )
      if (existRes.rows.length > 0) {
        const existId = existRes.rows[0].id
        const existVN = existRes.rows[0].version_number
        const updRes = await client.query(
          `UPDATE project_versions
           SET snapshot = $1, changes = $2, name = $3, description = $4, created_by = $5, created_at = CURRENT_TIMESTAMP
           WHERE id = $6
           RETURNING id, version_number, name, description, status_date, created_by, created_at`,
          [JSON.stringify(snapshot), changes ? JSON.stringify(changes) : null,
           statusDate, description, auth.value.userId, existId],
        )
        row = updRes.rows[0]
        row.version_number = existVN
      } else {
        const maxRes = await client.query(
          'SELECT COALESCE(MAX(version_number), 0) AS mx FROM project_versions WHERE project_id = $1',
          [projectId],
        )
        const nextVersion = (maxRes.rows[0].mx as number) + 1
        const insRes = await client.query(
          `INSERT INTO project_versions (project_id, version_number, name, description, snapshot, changes, status_date, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING id, version_number, name, description, status_date, created_by, created_at`,
          [projectId, nextVersion, statusDate, description, JSON.stringify(snapshot),
           changes ? JSON.stringify(changes) : null, statusDate, auth.value.userId],
        )
        row = insRes.rows[0]
      }
    } else {
      const maxRes = await client.query(
        'SELECT COALESCE(MAX(version_number), 0) AS mx FROM project_versions WHERE project_id = $1',
        [projectId],
      )
      const nextVersion = (maxRes.rows[0].mx as number) + 1
      const finalName = body.name || `快照 #${nextVersion}`
      const insRes = await client.query(
        `INSERT INTO project_versions (project_id, version_number, name, description, snapshot, changes, status_date, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id, version_number, name, description, status_date, created_by, created_at`,
        [projectId, nextVersion, finalName, description, JSON.stringify(snapshot),
         changes ? JSON.stringify(changes) : null, null, auth.value.userId],
      )
      row = insRes.rows[0]
    }

    await client.query('COMMIT')

    return NextResponse.json(success({
      ...row,
      task_count: snapshotTasks.length,
      changes,
    }), { status: 201 })
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('POST /api/versions:', err)
    return NextResponse.json(failure('Save failed', 500), { status: 500 })
  } finally {
    client.release()
  }
}

// PUT /api/versions/[projectId] — 更新版本元数据
// body: { id, name?, description? }
export async function PUT(req: NextRequest, { params }: Params) {
  const auth = getAuthUser(req)
  if (!auth.ok) return NextResponse.json(auth, { status: auth.code ?? 401 })
  const writeBlock = requireWrite(auth); if (writeBlock) return writeBlock
  const { projectId } = await params

  if (auth.value.role !== 'administrator' && !(await verifyOwner(projectId, auth.value.userId)))
    return NextResponse.json(failure('Not found', 404), { status: 404 })

  const { id, name, description } = await req.json()
  if (!id) return NextResponse.json(failure('id required', 400), { status: 400 })

  const r = await pool.query(
    `UPDATE project_versions
     SET name        = COALESCE($1, name),
         description = COALESCE($2, description)
     WHERE id = $3 AND project_id = $4
     RETURNING id, version_number, name, description, status_date, created_by, created_at`,
    [name ?? null, description ?? null, id, projectId],
  )
  if (!r.rows[0]) return NextResponse.json(failure('Not found', 404), { status: 404 })
  return NextResponse.json(success(r.rows[0]))
}

// DELETE /api/versions/[projectId] — 删除版本
// body: { id }
export async function DELETE(req: NextRequest, { params }: Params) {
  const auth = getAuthUser(req)
  if (!auth.ok) return NextResponse.json(auth, { status: auth.code ?? 401 })
  const writeBlock = requireWrite(auth); if (writeBlock) return writeBlock
  const { projectId } = await params

  if (auth.value.role !== 'administrator' && !(await verifyOwner(projectId, auth.value.userId)))
    return NextResponse.json(failure('Not found', 404), { status: 404 })

  const { id } = await req.json()
  if (!id) return NextResponse.json(failure('id required', 400), { status: 400 })

  await pool.query('DELETE FROM project_versions WHERE id = $1 AND project_id = $2', [id, projectId])
  return NextResponse.json(success({ deleted: id }))
}
