import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser } from '@/lib/middleware'
import { hasProjectAccess } from '@/lib/projectAccess'
import pool from '@/lib/db'
import { success, failure } from '@/lib/result'

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await getAuthUser(req)
  if (!auth.ok) return NextResponse.json(auth, { status: auth.code ?? 401 })
  const { id } = await params
  if (!(await hasProjectAccess(id, auth.value))) return NextResponse.json(failure('Not found', 404), { status: 404 })
  const rows = await pool.query(`SELECT h.id, h.baseline->>'sourceVersionName' AS name,
    h.previous_baseline->>'sourceVersionName' AS previous_name, h.baseline->>'reason' AS reason,
    h.created_at, u.username FROM project_baseline_history h LEFT JOIN users u ON u.id = h.created_by
    WHERE h.project_id = $1 ORDER BY h.created_at DESC, h.id DESC LIMIT 100`, [id])
  return NextResponse.json(success(rows.rows), { headers: { 'Cache-Control': 'no-store' } })
}
