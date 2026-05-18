import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

const CLI_DIR = path.join(process.cwd(), 'aspose-tasks-cli', 'publish')
const CLI_BIN = path.join(CLI_DIR, 'aspose-tasks-cli')
const CLI_DLL = path.join(CLI_DIR, 'aspose-tasks-cli.dll')
const LICENSE_ENV = process.env.ASPOSE_TASKS_LICENSE ?? '/Users/acai/AsposeLicense/Aspose.Total.lic'

/** Aspose CLI 子进程超时（毫秒）。MPP 文件可能较大，给 60s。*/
const RUNNER_TIMEOUT_MS = 60_000

export interface ImportResult {
  tasks: ImportTaskDto[]
  dependencies: ImportDepDto[]
  status_date: string | null
  project_lines?: ImportProjectLineDto[]
}

export interface ImportTaskDto {
  task_code: string
  level: number
  parent_task_code: string
  name: string
  assignee: string | null
  start_date: string | null
  end_date: string | null
  duration: number | null
  is_milestone: boolean
  auto_schedule: boolean
  note: string | null
  percent_done?: number | null
  constraint_type?: string | null
  constraint_date?: string | null
  rollup?: boolean
  inactive?: boolean
  project_boundary?: string | null
  status?: string | null
  deadline?: string | null
  baseline_end_date?: string | null
}

export interface ImportDepDto {
  from_task_code: string
  to_task_code: string
  type: number
  lag: number
  active?: boolean
}

export interface ImportProjectLineDto {
  name: string
  line_date: string
  color: string
  visible: boolean
}

export interface ExportTaskDto {
  task_code: string
  parent_task_code: string | null
  name: string
  start_date: string | null
  end_date: string | null
  duration: number | null
  percent_done: number | null
  is_milestone: boolean
  auto_schedule: boolean
  note: string | null
  constraint_type: string | null
  constraint_date: string | null
  rollup: boolean
  inactive: boolean
  deadline: string | null
  order_index: number
}

export interface ExportDepDto {
  from_task_code: string
  to_task_code: string
  type: number
  lag: number
  active?: boolean
}

export interface ExportPayload {
  name: string
  start_date: string | null
  end_date: string | null
  status_date: string | null
  tasks: ExportTaskDto[]
  dependencies: ExportDepDto[]
}

interface RunResult { stdout: string; stderr: string }

async function runCli(args: string[]): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const useBinary = !process.env.ASPOSE_FORCE_DOTNET
    const cmd = useBinary ? CLI_BIN : 'dotnet'
    const cmdArgs = useBinary ? args : [CLI_DLL, ...args]

    const child = spawn(cmd, cmdArgs, {
      env: { ...process.env, ASPOSE_TASKS_LICENSE: LICENSE_ENV },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const out: Buffer[] = []
    const err: Buffer[] = []
    child.stdout.on('data', c => out.push(c))
    child.stderr.on('data', c => err.push(c))

    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`aspose-tasks-cli timeout after ${RUNNER_TIMEOUT_MS}ms`))
    }, RUNNER_TIMEOUT_MS)

    child.on('error', e => { clearTimeout(timer); reject(e) })
    child.on('close', code => {
      clearTimeout(timer)
      const stdout = Buffer.concat(out).toString('utf-8')
      const stderr = Buffer.concat(err).toString('utf-8')
      if (code !== 0) {
        reject(new Error(`aspose-tasks-cli exited ${code}: ${stderr || stdout}`))
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

export async function importMpp(mppBuffer: Buffer): Promise<ImportResult> {
  const dir = await mkdtemp(path.join(tmpdir(), 'aspose-mpp-'))
  const inPath = path.join(dir, 'in.mpp')
  try {
    await writeFile(inPath, mppBuffer)
    const { stdout } = await runCli(['import', inPath])
    return JSON.parse(stdout) as ImportResult
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

export async function exportMpp(payload: ExportPayload): Promise<Buffer> {
  const dir = await mkdtemp(path.join(tmpdir(), 'aspose-mpp-'))
  const inJson = path.join(dir, 'in.json')
  const outMpp = path.join(dir, 'out.mpp')
  try {
    await writeFile(inJson, JSON.stringify(payload))
    await runCli(['export', inJson, outMpp])
    return await readFile(outMpp)
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}
