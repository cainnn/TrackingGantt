import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { getAuthUser, requireWrite } from '@/lib/middleware'
import { success, failure } from '@/lib/result'

type Params = { params: Promise<{ projectId: string }> }

// POST /api/versions/[projectId]/restore
// body: { version_id }
// 从快照恢复工作版本：删除现有任务+依赖，用快照数据重建
export async function POST(req: NextRequest, { params }: Params) {
  const auth = getAuthUser(req)
  if (!auth.ok) return NextResponse.json(auth, { status: auth.code ?? 401 })
  const writeBlock = requireWrite(auth); if (writeBlock) return writeBlock
  const { projectId } = await params

  // administrator 可操作所有项目，其他角色只能操作自己的项目
  const proj = auth.value.role === 'administrator'
    ? await pool.query('SELECT id FROM projects WHERE id = $1', [projectId])
    : await pool.query('SELECT id FROM projects WHERE id = $1 AND user_id = $2', [projectId, auth.value.userId])
  if (!proj.rows.length) return NextResponse.json(failure('Not found', 404), { status: 404 })

  const { version_id } = await req.json()
  if (!version_id) return NextResponse.json(failure('version_id required', 400), { status: 400 })

  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query('SET LOCAL lock_timeout = \'10s\'')
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [projectId])

    // 1. 读取快照
    const vRes = await client.query(
      'SELECT snapshot, name, version_number FROM project_versions WHERE id = $1 AND project_id = $2',
      [version_id, projectId],
    )
    if (!vRes.rows.length) {
      await client.query('ROLLBACK')
      return NextResponse.json(failure('Version not found', 404), { status: 404 })
    }

    const { snapshot, name: versionName, version_number } = vRes.rows[0]
    const snapshotTasks = snapshot.tasks || []
    const snapshotDeps = snapshot.dependencies || []

    // 2. 先自动保存当前状态为"恢复前快照"（安全网）
    const [currentTasks, currentDeps] = await Promise.all([
      client.query('SELECT * FROM tasks WHERE project_id = $1 AND is_deleted = false ORDER BY order_index', [projectId]),
      client.query(
        `SELECT d.* FROM dependencies d
         JOIN tasks ft ON ft.id = d.from_task_id AND ft.is_deleted = false
         JOIN tasks tt ON tt.id = d.to_task_id AND tt.is_deleted = false
         WHERE d.project_id = $1`, [projectId]),
    ])
    const maxRes = await client.query(
      'SELECT COALESCE(MAX(version_number), 0) AS mx FROM project_versions WHERE project_id = $1',
      [projectId],
    )
    const autoVersion = (maxRes.rows[0].mx as number) + 1
    await client.query(
      `INSERT INTO project_versions (project_id, version_number, name, description, snapshot, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        projectId, autoVersion,
        `恢复前自动备份`,
        `恢复「${versionName}」(#${version_number}) 前的自动备份`,
        JSON.stringify({ tasks: currentTasks.rows, dependencies: currentDeps.rows }),
        auth.value.userId,
      ],
    )

    // 3. 清除当前依赖和任务
    await client.query('DELETE FROM dependencies WHERE project_id = $1', [projectId])
    // 先解除 parent_id 外键约束，再删除
    await client.query('UPDATE tasks SET parent_id = NULL WHERE project_id = $1', [projectId])
    await client.query('DELETE FROM tasks WHERE project_id = $1', [projectId])

    // 4. 插入快照任务（先不设 parent_id，避免外键冲突）
    for (const t of snapshotTasks) {
      await client.query(
        `INSERT INTO tasks (id, project_id, task_code, name, assignee,
          start_date, end_date, duration, duration_unit, percent_done,
          is_milestone, auto_schedule, note, order_index, is_deleted)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,false)`,
        [
          t.id, projectId, t.task_code, t.name, t.assignee ?? null,
          t.start_date ?? null, t.end_date ?? null, t.duration ?? null,
          t.duration_unit ?? 'day', t.percent_done ?? 0,
          t.is_milestone ?? false, t.auto_schedule ?? true,
          t.note ?? null, t.order_index ?? 0,
        ],
      )
    }

    // 5. 设置 parent_id
    for (const t of snapshotTasks) {
      if (t.parent_id) {
        await client.query('UPDATE tasks SET parent_id = $1 WHERE id = $2', [t.parent_id, t.id])
      }
    }

    // 6. 插入快照依赖
    for (const d of snapshotDeps) {
      await client.query(
        `INSERT INTO dependencies (id, project_id, from_task_id, to_task_id, type, lag)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [d.id, projectId, d.from_task_id, d.to_task_id, d.type ?? 2, d.lag ?? 0],
      )
    }

    await client.query('COMMIT')

    // 7. 返回恢复后的完整数据
    const [newTasks, newDeps] = await Promise.all([
      pool.query('SELECT * FROM tasks WHERE project_id = $1 AND is_deleted = false ORDER BY order_index', [projectId]),
      pool.query(
        `SELECT d.* FROM dependencies d
         JOIN tasks ft ON ft.id = d.from_task_id AND ft.is_deleted = false
         JOIN tasks tt ON tt.id = d.to_task_id AND tt.is_deleted = false
         WHERE d.project_id = $1`, [projectId]),
    ])

    return NextResponse.json(success({
      tasks: newTasks.rows,
      dependencies: newDeps.rows,
      restored_from: { version_id, version_number, name: versionName },
    }))
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('POST /api/versions/restore:', err)
    const msg = err instanceof Error ? err.message : 'Restore failed'
    return NextResponse.json(failure(msg, 500), { status: 500 })
  } finally {
    client.release()
  }
}
