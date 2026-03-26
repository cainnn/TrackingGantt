import { NextRequest, NextResponse } from 'next/server'
import pool from '@/lib/db'
import { getAuthUser } from '@/lib/middleware'
import { success, failure } from '@/lib/result'

export async function GET(req: NextRequest) {
  const auth = getAuthUser(req)
  if (!auth.ok) return NextResponse.json(auth, { status: auth.code ?? 401 })

  // 先获取所有项目
  const projectsResult = await pool.query(
    'SELECT * FROM projects WHERE user_id = $1 ORDER BY created_at DESC',
    [auth.value.userId]
  )

  // 为每个项目计算进度
  const projects = await Promise.all(
    projectsResult.rows.map(async (p: any) => {
      // 计算总工期和已完成工日（基于任务的percent_done）
      const progressResult = await pool.query(
        `SELECT
           COALESCE(SUM(duration), 0) as total_duration,
           COALESCE(SUM(duration * percent_done / 100.0), 0) as completed_duration
         FROM tasks
         WHERE project_id = $1
           AND is_deleted = false
           AND start_date IS NOT NULL
           AND end_date IS NOT NULL
           AND duration IS NOT NULL`,
        [p.id]
      )

      const totalDuration = Number(progressResult.rows[0].total_duration) || 0
      const completedDuration = Number(progressResult.rows[0].completed_duration) || 0
      const progress = totalDuration > 0 ? Math.round((completedDuration / totalDuration) * 100) : 0

      return {
        ...p,
        progress,
      }
    })
  )

  return NextResponse.json(success(projects))
}

export async function POST(req: NextRequest) {
  const auth = getAuthUser(req)
  if (!auth.ok) return NextResponse.json(auth, { status: auth.code ?? 401 })

  const body = await req.json()
  const { name, start_date, end_date, status_date } = body as {
    name?: string
    start_date?: string
    end_date?: string
    status_date?: string
  }

  if (!name) {
    return NextResponse.json(failure('name is required', 400), { status: 400 })
  }

  const result = await pool.query(
    'INSERT INTO projects (user_id, name, start_date, end_date, status_date) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [auth.value.userId, name, start_date ?? null, end_date ?? null, status_date ?? null]
  )
  return NextResponse.json(success(result.rows[0]), { status: 201 })
}
