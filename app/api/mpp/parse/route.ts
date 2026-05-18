import { NextRequest, NextResponse } from 'next/server'
import { getAuthUser, requireWrite } from '@/lib/middleware'
import { success, failure } from '@/lib/result'
import { importMpp } from '@/lib/asposeTasksRunner'

/** 上传 .mpp 文件上限：20MB */
const MAX_MPP_SIZE = 20 * 1024 * 1024

export async function POST(req: NextRequest) {
  const auth = getAuthUser(req)
  if (!auth.ok) return NextResponse.json(auth, { status: auth.code ?? 401 })
  const writeBlock = requireWrite(auth); if (writeBlock) return writeBlock

  let form: FormData
  try {
    form = await req.formData()
  } catch {
    return NextResponse.json(failure('Invalid multipart payload', 400), { status: 400 })
  }

  const file = form.get('file')
  if (!(file instanceof File)) {
    return NextResponse.json(failure('缺少 file 字段', 400), { status: 400 })
  }
  if (file.size === 0) {
    return NextResponse.json(failure('文件为空', 400), { status: 400 })
  }
  if (file.size > MAX_MPP_SIZE) {
    return NextResponse.json(failure(`文件过大（>${MAX_MPP_SIZE / 1024 / 1024}MB）`, 400), { status: 400 })
  }

  const buf = Buffer.from(await file.arrayBuffer())
  try {
    const parsed = await importMpp(buf)
    return NextResponse.json(success(parsed))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('MPP parse error:', msg)
    return NextResponse.json(failure(`解析 MPP 失败：${msg}`, 500), { status: 500 })
  }
}
