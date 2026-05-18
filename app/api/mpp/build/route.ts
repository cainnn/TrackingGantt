import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser } from '@/lib/middleware'
import { failure } from '@/lib/result'
import { exportMpp, type ExportPayload } from '@/lib/asposeTasksRunner'

const MAX_TASKS = 10_000

export async function POST(req: NextRequest) {
  const auth = getAuthUser(req)
  if (!auth.ok) return NextResponse.json(auth, { status: auth.code ?? 401 })

  let payload: ExportPayload
  try {
    payload = await req.json()
  } catch {
    return NextResponse.json(failure('Invalid JSON', 400), { status: 400 })
  }

  if (!payload || !Array.isArray(payload.tasks)) {
    return NextResponse.json(failure('Missing tasks[]', 400), { status: 400 })
  }
  if (payload.tasks.length > MAX_TASKS) {
    return NextResponse.json(failure(`任务数量超过上限 ${MAX_TASKS}`, 400), { status: 400 })
  }

  try {
    const mpp = await exportMpp(payload)
    const filename = encodeURIComponent((payload.name || 'project') + '.mpp')
    return new NextResponse(new Uint8Array(mpp), {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.ms-project',
        'Content-Disposition': `attachment; filename*=UTF-8''${filename}`,
        'Cache-Control': 'no-store',
      },
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('MPP build error:', msg)
    return NextResponse.json(failure(`生成 MPP 失败：${msg}`, 500), { status: 500 })
  }
}
