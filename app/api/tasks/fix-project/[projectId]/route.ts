import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { getAuthUser, requireWrite } from '@/lib/middleware'
import { success, failure } from '@/lib/result'
import { cascadeDependencies, updateSummaryTasksDates } from '@/lib/scheduling'

type Params = { params: Promise<{ projectId: string }> }

export async function POST(req: NextRequest, { params }: Params) {
  const auth = getAuthUser(req)
  if (!auth.ok) return NextResponse.json(auth, { status: 401 })
  const writeBlock = requireWrite(auth); if (writeBlock) return writeBlock

  const { projectId } = await params

  const owned = await pool.query(
    'SELECT id FROM projects WHERE id = $1 AND user_id = $2',
    [projectId, auth.value.userId]
  )
  if (owned.rows.length === 0) {
    return NextResponse.json(failure('Project not found', 404), { status: 404 })
  }

  const client = await pool.connect()
  try {
    await client.query('BEGIN')

    // 1. 为有依赖但 auto_schedule=false 的任务启用自动排程
    const enableRes = await client.query(
      `UPDATE tasks t
       SET auto_schedule = true, updated_at = NOW()
       WHERE t.project_id = $1 AND t.is_deleted = false AND t.auto_schedule = false
         AND EXISTS (
           SELECT 1 FROM dependencies d
           JOIN tasks ft ON ft.id = d.from_task_id AND ft.is_deleted = false
           WHERE d.to_task_id = t.id
         )`,
      [projectId]
    )

    // 2. 使用完整级联引擎重算日期（自动跳过父子依赖）
    const cascadedIds = await cascadeDependencies(client, projectId)

    // 3. 更新摘要任务日期
    await updateSummaryTasksDates(client, projectId)

    await client.query('COMMIT')

    const totalFixed = enableRes.rowCount! + cascadedIds.length
    return NextResponse.json(success({
      fixed: totalFixed,
      enabled: enableRes.rowCount,
      cascaded: cascadedIds.length,
      message: totalFixed > 0
        ? `已修复 ${totalFixed} 个任务（启用自动排程 ${enableRes.rowCount} 个，级联更新日期 ${cascadedIds.length} 个）`
        : '所有任务日期已正确，无需修复',
    }))
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {})
    console.error('Error fixing project:', err)
    return NextResponse.json(failure('修复失败: ' + (err instanceof Error ? err.message : 'Unknown'), 500), { status: 500 })
  } finally {
    client.release()
  }
}
