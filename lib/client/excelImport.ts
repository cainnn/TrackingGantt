'use client'

import * as XLSX from 'xlsx'

const DEP_TYPE_MAP: Record<string, number> = { SS: 0, SF: 1, FS: 2, FF: 3 }

export interface ImportTask {
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
}

export interface ImportDep {
  from_task_code: string
  to_task_code: string
  type: number
  lag: number
}

function fmtD(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function parseDateCell(v: unknown): string | null {
  if (!v) return null
  // Date object (from XLSX cellDates:true)
  if (typeof v === 'object' && v !== null && typeof (v as Date).getTime === 'function') {
    const d = v as Date
    if (isNaN(d.getTime())) return null
    return fmtD(d)
  }
  const s = String(v).trim()
  if (!s) return null
  // YYYY-MM-DD or YYYY-MM-DDT...
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10)
  // Excel serial number
  const n = Number(s)
  if (!isNaN(n) && n > 40000 && n < 60000) {
    return fmtD(new Date((n - 25569) * 86400000))
  }
  // Fallback: try parsing any date string (e.g. "Mon Feb 23 2026 ...")
  const d = new Date(s)
  if (!isNaN(d.getTime())) return fmtD(d)
  return null
}

// Parse predecessor strings like "3FS+2d,5SS-1d" or "T-003FS+2d,T-005SS-1d"
const PRED_RE = /([A-Za-z]*-?\d+)(SS|SF|FS|FF)?([+-]\d+d)?/g

function parsePredecessors(s: string, toTaskCode: string): ImportDep[] {
  if (!s || !s.trim()) return []
  const deps: ImportDep[] = []
  let m: RegExpExecArray | null
  PRED_RE.lastIndex = 0
  while ((m = PRED_RE.exec(s)) !== null) {
    const fromCode = m[1]
    const type = m[2] ? DEP_TYPE_MAP[m[2]] ?? 2 : 2
    const lag = m[3] ? parseInt(m[3].replace('d', '')) : 0
    deps.push({ from_task_code: fromCode, to_task_code: toTaskCode, type, lag })
  }
  return deps
}

export interface ImportProjectLine {
  name: string
  line_date: string
  color: string
  visible: boolean
}

export interface ParseResult {
  tasks: ImportTask[]
  dependencies: ImportDep[]
  statusDate?: string | null
  projectLines?: ImportProjectLine[]
}

export interface ImportValidationError {
  type: 'circular_parent' | 'circular_dep' | 'date_inverted' | 'date_invalid' | 'date_range' | 'orphan_parent' | 'dup_dep'
  message: string
  taskCodes?: string[]
}

/** 允许的最大日期跨度（天） */
const MAX_DATE_SPAN_DAYS = 3650 // ~10 年

/**
 * 校验解析后的导入数据，检测会导致渲染崩溃的问题。
 * 返回空数组表示数据合法。
 */
export function validateImportData(
  tasks: ImportTask[],
  dependencies: ImportDep[],
): ImportValidationError[] {
  const errors: ImportValidationError[] = []
  const codeSet = new Set(tasks.map(t => t.task_code))

  // ── 1. 检测父任务循环引用（A→B→C→A 会导致 flatRows walk 无限递归） ──
  {
    const parentMap = new Map<string, string>() // child → parent
    for (const t of tasks) {
      if (t.parent_task_code && codeSet.has(t.parent_task_code)) {
        parentMap.set(t.task_code, t.parent_task_code)
      }
    }
    const visited = new Set<string>()
    const inStack = new Set<string>()
    function dfs(code: string): string[] | null {
      if (inStack.has(code)) return [code] // 发现环，返回环的起点
      if (visited.has(code)) return null
      visited.add(code)
      inStack.add(code)
      const parent = parentMap.get(code)
      if (parent) {
        const cycle = dfs(parent)
        if (cycle) {
          cycle.push(code)
          return cycle
        }
      }
      inStack.delete(code)
      return null
    }
    for (const code of parentMap.keys()) {
      if (visited.has(code)) continue
      const cycle = dfs(code)
      if (cycle) {
        // 提取环中的实际循环部分
        const start = cycle[0]
        const startIdx = cycle.indexOf(start, 1)
        const ring = startIdx > 0 ? cycle.slice(0, startIdx + 1) : cycle
        const names = ring.map(c => tasks.find(t => t.task_code === c)?.name ?? c)
        errors.push({
          type: 'circular_parent',
          message: `父任务循环引用：${names.join(' → ')}`,
          taskCodes: ring,
        })
        break // 一个循环就足以阻止导入
      }
    }
  }

  // ── 2. 检测依赖循环（A→B→C→A 会导致关键路径计算异常） ──
  {
    const adj = new Map<string, string[]>()
    for (const d of dependencies) {
      if (!codeSet.has(d.from_task_code) || !codeSet.has(d.to_task_code)) continue
      if (!adj.has(d.from_task_code)) adj.set(d.from_task_code, [])
      adj.get(d.from_task_code)!.push(d.to_task_code)
    }
    const visited = new Set<string>()
    const inStack = new Set<string>()
    function dfs(code: string): string[] | null {
      if (inStack.has(code)) return [code]
      if (visited.has(code)) return null
      visited.add(code)
      inStack.add(code)
      for (const next of adj.get(code) ?? []) {
        const cycle = dfs(next)
        if (cycle) { cycle.push(code); return cycle }
      }
      inStack.delete(code)
      return null
    }
    for (const code of adj.keys()) {
      if (visited.has(code)) continue
      const cycle = dfs(code)
      if (cycle) {
        const start = cycle[0]
        const startIdx = cycle.indexOf(start, 1)
        const ring = startIdx > 0 ? cycle.slice(0, startIdx + 1).reverse() : cycle.reverse()
        const names = ring.map(c => tasks.find(t => t.task_code === c)?.name ?? c)
        errors.push({
          type: 'circular_dep',
          message: `依赖循环引用：${names.join(' → ')}`,
          taskCodes: ring,
        })
        break
      }
    }
  }

  // ── 3. 检测日期问题 ──
  const VALID_DATE_RE = /^\d{4}-\d{2}-\d{2}$/
  let globalMin: string | null = null
  let globalMax: string | null = null

  for (const t of tasks) {
    // 3a. 日期格式无效（parseDateCell 应已处理，但做二次检查）
    if (t.start_date && !VALID_DATE_RE.test(t.start_date)) {
      errors.push({
        type: 'date_invalid',
        message: `任务「${t.name}」(${t.task_code}) 开始日期格式无效：${t.start_date}`,
        taskCodes: [t.task_code],
      })
    }
    if (t.end_date && !VALID_DATE_RE.test(t.end_date)) {
      errors.push({
        type: 'date_invalid',
        message: `任务「${t.name}」(${t.task_code}) 结束日期格式无效：${t.end_date}`,
        taskCodes: [t.task_code],
      })
    }

    // 3b. 开始日期晚于结束日期（会导致任务条宽度为负）
    if (t.start_date && t.end_date && t.start_date > t.end_date) {
      errors.push({
        type: 'date_inverted',
        message: `任务「${t.name}」(${t.task_code}) 开始日期 ${t.start_date} 晚于结束日期 ${t.end_date}`,
        taskCodes: [t.task_code],
      })
    }

    // 记录全局日期范围
    if (t.start_date && VALID_DATE_RE.test(t.start_date)) {
      if (!globalMin || t.start_date < globalMin) globalMin = t.start_date
    }
    if (t.end_date && VALID_DATE_RE.test(t.end_date)) {
      if (!globalMax || t.end_date > globalMax) globalMax = t.end_date
    }
  }

  // 3c. 整体日期跨度过大（会导致 SVG 尺寸爆炸，浏览器卡死）
  if (globalMin && globalMax) {
    const minMs = new Date(globalMin + 'T00:00:00').getTime()
    const maxMs = new Date(globalMax + 'T00:00:00').getTime()
    const spanDays = Math.round((maxMs - minMs) / 86_400_000)
    if (spanDays > MAX_DATE_SPAN_DAYS) {
      errors.push({
        type: 'date_range',
        message: `任务日期跨度 ${spanDays} 天（${globalMin} ~ ${globalMax}）超过上限 ${MAX_DATE_SPAN_DAYS} 天，会导致渲染异常`,
      })
    }
  }

  // ── 4. 检测引用了不存在的父任务编码 ──
  for (const t of tasks) {
    if (t.parent_task_code && !codeSet.has(t.parent_task_code)) {
      errors.push({
        type: 'orphan_parent',
        message: `任务「${t.name}」(${t.task_code}) 引用了不存在的父任务编码 ${t.parent_task_code}`,
        taskCodes: [t.task_code],
      })
    }
  }

  return errors
}

export async function parseExcelFile(file: File): Promise<ParseResult> {
  const buf = await file.arrayBuffer()
  const wb = XLSX.read(buf, { cellDates: true })
  const ws = wb.Sheets[wb.SheetNames[0]]
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(ws)

  const tasks: ImportTask[] = []
  const dependencies: ImportDep[] = []

  for (const row of rows) {
    const name = String(row['任务名称'] ?? '').trim()
    if (!name) continue

    const taskCode = String(row['任务编码'] ?? '').trim()
    if (!taskCode) continue

    const rawParentCode = String(row['父任务编码'] ?? '').trim()
    const task: ImportTask = {
      task_code: taskCode,
      level: Number(row['层级']) || 1,
      // 防止自引用：父任务编码不能等于自身编码
      parent_task_code: rawParentCode === taskCode ? '' : rawParentCode,
      name,
      assignee: String(row['责任人'] ?? '').trim() || null,
      start_date: parseDateCell(row['开始日期']),
      end_date: parseDateCell(row['结束日期']),
      duration: row['工期'] != null ? Number(row['工期']) || 0 : null,
      is_milestone: String(row['里程碑'] ?? '').trim() === '是',
      auto_schedule: String(row['自动排程'] ?? '是').trim() !== '否',
      note: String(row['备注'] ?? '').trim() || null,
    }
    tasks.push(task)

    const predStr = String(row['前置依赖'] ?? '').trim()
    if (predStr) {
      const parsed = parsePredecessors(predStr, taskCode)
      // If a separate "延迟" column exists, use it to override lag for all deps
      const lagOverride = row['延迟']
      if (lagOverride != null && String(lagOverride).trim() !== '') {
        const lagVal = Number(lagOverride)
        if (!isNaN(lagVal)) {
          parsed.forEach(d => { d.lag = lagVal })
        }
      }
      dependencies.push(...parsed)
    }
  }

  // Parse optional "项目设置" sheet
  let statusDate: string | null = null
  const projectLines: ImportProjectLine[] = []
  const settingsSheet = wb.Sheets['项目设置']
  if (settingsSheet) {
    const settingsRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(settingsSheet)
    for (const row of settingsRows) {
      const type = String(row['类型'] ?? '').trim()
      if (type === '状态日期') {
        statusDate = parseDateCell(row['日期'])
      } else if (type === '项目线') {
        const name = String(row['名称'] ?? '').trim()
        const lineDate = parseDateCell(row['日期'])
        if (name && lineDate) {
          projectLines.push({
            name,
            line_date: lineDate,
            color: String(row['颜色'] ?? '#f59e0b').trim() || '#f59e0b',
            visible: String(row['可见'] ?? '是').trim() !== '否',
          })
        }
      }
    }
  }

  return { tasks, dependencies, statusDate: statusDate || undefined, projectLines: projectLines.length > 0 ? projectLines : undefined }
}
