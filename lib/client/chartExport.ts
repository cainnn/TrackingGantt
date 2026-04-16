'use client'

import type { Task, Dependency, ProjectLine } from '@/types'

// ── A4 landscape in pt ──────────────────────────────────────────────────
const A4W = 841.89
const A4H = 595.28
const MARGIN = 28
const CONTENT_W = A4W - MARGIN * 2

// ── Fixed layout ────────────────────────────────────────────────────────
const TITLE_H = 28
const HDR_H   = 24
const ROW_H   = 28
const BAR_H   = 14
const BAR_TOP = (ROW_H - BAR_H) / 2
const F_BAR   = 8
const F_LABEL = 8
const F_HDR   = 10
const F_TITLE = 13

// ── Helpers ─────────────────────────────────────────────────────────────
function sod(d: Date): Date { const r = new Date(d); r.setHours(0,0,0,0); return r }
function addDays(d: Date, n: number): Date { const r = new Date(d); r.setDate(r.getDate()+n); return r }
function diffDays(a: Date, b: Date): number { return Math.round((sod(b).getTime()-sod(a).getTime())/86400000) }
function escXml(s: string): string { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;') }

interface FlatRow { task: Task; level: number }

function flattenForExport(tasks: Task[]): FlatRow[] {
  const kids: Record<string, Task[]> = {}
  tasks.forEach(t => {
    const k = t.parent_id ?? '__root__'
    if (!kids[k]) kids[k] = []
    kids[k].push(t)
  })
  Object.values(kids).forEach(arr => arr.sort((a,b) => a.order_index - b.order_index))
  const result: FlatRow[] = []
  function walk(pid: string | null, level: number) {
    ;(kids[pid ?? '__root__'] ?? []).forEach(t => {
      result.push({ task: t, level })
      walk(t.id, level + 1)
    })
  }
  walk(null, 1)
  return result
}

function computeTimeline(tasks: Task[]) {
  const dates = tasks.flatMap(t => {
    const r: Date[] = []
    if (t.start_date) r.push(sod(new Date(t.start_date)))
    if (t.end_date) r.push(sod(new Date(t.end_date)))
    return r
  })
  if (dates.length === 0) {
    const o = sod(new Date())
    return { origin: o, totalDays: 60 }
  }
  const mn = new Date(Math.min(...dates.map(d => d.getTime())))
  const mx = new Date(Math.max(...dates.map(d => d.getTime())))
  const origin = new Date(mn.getFullYear(), mn.getMonth(), 1)
  const mxEnd = new Date(mx.getFullYear(), mx.getMonth() + 2, 0)
  return { origin, totalDays: diffDays(origin, mxEnd) }
}

// ── Ellipsis row marker ─────────────────────────────────────────────────
interface EllipsisRow { isEllipsis: true; count: number }
type ExportRow = (FlatRow & { isEllipsis?: false }) | EllipsisRow

// ── Shared chart data ───────────────────────────────────────────────────
interface ChartData {
  rows: ExportRow[]
  activeTasks: Task[]
  dependencies: Dependency[]
  origin: Date
  totalDays: number
  colW: number
  months: { label: string; startD: number; endD: number }[]
  projectName: string
  statusDate?: string | null
  projectLines?: ProjectLine[]
  summarySet: Set<string>
  projectStart: string | null
  projectEnd: string | null
  projectStartDefined: string | null
  projectEndDefined: string | null
}

function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`
}

// ── Filter key tasks for single-page export ─────────────────────────────
// Returns: earliest tasks + tasks crossing status date + latest tasks,
// with ellipsis markers for omitted sections, all fitting on one page.
function selectKeyTasks(flatRows: FlatRow[], statusDate: string | null, maxRows: number): ExportRow[] {
  // Separate leaf tasks (with dates) for selection; keep summaries aside
  const leafRows = flatRows.filter(r => r.task.start_date && r.task.end_date)
  if (leafRows.length <= maxRows) return flatRows // all fit — no filtering needed

  const sd = statusDate ? sod(new Date(statusDate)) : null

  // Categorize tasks
  const crossing: FlatRow[] = []   // tasks that span across status date
  if (sd) {
    for (const r of leafRows) {
      const s = sod(new Date(r.task.start_date!))
      const e = sod(new Date(r.task.end_date!))
      if (s < sd && e > sd) crossing.push(r)
    }
  }

  // Sort by start_date for earliest/latest picks
  const byStart = [...leafRows].sort((a, b) =>
    new Date(a.task.start_date!).getTime() - new Date(b.task.start_date!).getTime())
  const byEnd = [...leafRows].sort((a, b) =>
    new Date(b.task.end_date!).getTime() - new Date(a.task.end_date!).getTime())

  // Budget rows: reserve slots for ellipsis separators (up to 2)
  const budgetForTasks = maxRows - 2 // 2 ellipsis rows
  const crossingBudget = Math.min(crossing.length, Math.ceil(budgetForTasks * 0.5))
  const remaining = budgetForTasks - crossingBudget
  const edgeBudget = Math.max(Math.floor(remaining / 2), 2)

  // Collect unique task IDs
  const selected = new Set<string>()
  const pickEarliest: FlatRow[] = []
  for (const r of byStart) {
    if (pickEarliest.length >= edgeBudget) break
    if (!selected.has(r.task.id)) { selected.add(r.task.id); pickEarliest.push(r) }
  }
  const pickCrossing: FlatRow[] = []
  for (const r of crossing) {
    if (pickCrossing.length >= crossingBudget) break
    if (!selected.has(r.task.id)) { selected.add(r.task.id); pickCrossing.push(r) }
  }
  const pickLatest: FlatRow[] = []
  for (const r of byEnd) {
    if (pickLatest.length >= edgeBudget) break
    if (!selected.has(r.task.id)) { selected.add(r.task.id); pickLatest.push(r) }
  }

  // Also include parent tasks for selected tasks
  const taskMap = new Map(flatRows.map(r => [r.task.id, r]))
  const parentRows: FlatRow[] = []
  for (const id of selected) {
    const r = taskMap.get(id)
    if (r?.task.parent_id && !selected.has(r.task.parent_id)) {
      const pr = taskMap.get(r.task.parent_id)
      if (pr) { selected.add(r.task.parent_id); parentRows.push(pr) }
    }
  }

  // Sort each group by original flat order index
  const orderMap = new Map(flatRows.map((r, i) => [r.task.id, i]))
  const sortByOrder = (arr: FlatRow[]) => arr.sort((a, b) => (orderMap.get(a.task.id) ?? 0) - (orderMap.get(b.task.id) ?? 0))

  sortByOrder(pickEarliest)
  sortByOrder(pickCrossing)
  sortByOrder(pickLatest)
  sortByOrder(parentRows)

  // Build final rows with ellipsis separators
  // Merge all selected into one ordered list, insert ellipsis where there are gaps
  const allSelected = [...new Set([...parentRows, ...pickEarliest, ...pickCrossing, ...pickLatest])]
  allSelected.sort((a, b) => (orderMap.get(a.task.id) ?? 0) - (orderMap.get(b.task.id) ?? 0))

  // Deduplicate
  const seen = new Set<string>()
  const deduped: FlatRow[] = []
  for (const r of allSelected) {
    if (!seen.has(r.task.id)) { seen.add(r.task.id); deduped.push(r) }
  }

  // Insert ellipsis markers where consecutive original indices have gaps
  const result: ExportRow[] = []
  for (let i = 0; i < deduped.length; i++) {
    const curIdx = orderMap.get(deduped[i].task.id) ?? 0
    if (i > 0) {
      const prevIdx = orderMap.get(deduped[i - 1].task.id) ?? 0
      if (curIdx - prevIdx > 1) {
        result.push({ isEllipsis: true, count: curIdx - prevIdx - 1 })
      }
    }
    result.push({ ...deduped[i], isEllipsis: false })
  }

  // Check if there are omitted tasks after the last selected task
  const lastIdx = orderMap.get(deduped[deduped.length - 1].task.id) ?? 0
  if (lastIdx < flatRows.length - 1) {
    result.push({ isEllipsis: true, count: flatRows.length - 1 - lastIdx })
  }

  return result
}

function prepareChartData(
  tasks: Task[], dependencies: Dependency[], projectName: string,
  statusDate?: string | null, projectLines?: ProjectLine[],
  fullExport = false,
  projectStartDate?: string | null, projectEndDate?: string | null,
): ChartData {
  const activeTasks = tasks.filter(t => !t.is_deleted)
  const allRows = flattenForExport(activeTasks)
  const { origin, totalDays } = computeTimeline(activeTasks)
  const colW = CONTENT_W / totalDays

  let rows: ExportRow[]
  if (fullExport) {
    rows = allRows.map(r => ({ ...r, isEllipsis: false as const }))
  } else {
    // Calculate max rows that fit on one A4 page
    const pageBodyH = A4H - MARGIN * 2 - TITLE_H - HDR_H
    const maxRows = Math.max(Math.floor(pageBodyH / ROW_H), 6)
    rows = selectKeyTasks(allRows, statusDate ?? null, maxRows)
  }

  const months: { label: string; startD: number; endD: number }[] = []
  let mStart = 0, mLabel = ''
  for (let d = 0; d <= totalDays; d++) {
    const date = addDays(origin, d)
    const label = `${date.getFullYear()}年${date.getMonth()+1}月`
    if (d === 0) { mStart = 0; mLabel = label }
    else if (label !== mLabel || d === totalDays) {
      months.push({ label: mLabel, startD: mStart, endD: d })
      mStart = d; mLabel = label
    }
  }

  const summarySet = new Set<string>()
  activeTasks.forEach(t => { if (t.parent_id) summarySet.add(t.parent_id) })

  const starts = activeTasks.map(t => t.start_date).filter(Boolean) as string[]
  const ends = activeTasks.map(t => t.end_date).filter(Boolean) as string[]
  const taskStart = starts.length ? fmtDate(new Date(starts.reduce((a,b) => a < b ? a : b))) : null
  const taskEnd = ends.length ? fmtDate(new Date(ends.reduce((a,b) => a > b ? a : b))) : null
  const projectStartDefined = projectStartDate ? projectStartDate.split('T')[0] : null
  const projectEndDefined = projectEndDate ? projectEndDate.split('T')[0] : null
  const projectStart = projectStartDefined ?? taskStart
  const projectEnd = projectEndDefined ?? taskEnd

  return { rows, activeTasks, dependencies, origin, totalDays, colW, months, projectName, statusDate, projectLines, summarySet, projectStart, projectEnd, projectStartDefined, projectEndDefined }
}

// ── Render header (title + month bar) ───────────────────────────────────
function renderHeader(cd: ChartData): string {
  const parts: string[] = []
  parts.push(`<text x="${CONTENT_W/2}" y="${TITLE_H - 12}" text-anchor="middle" font-size="${F_TITLE}" font-weight="bold" fill="#111827">${escXml(cd.projectName)}</text>`)
  if (cd.projectStart || cd.projectEnd) {
    const dateLine = `开工：${cd.projectStart ?? '—'}    完工：${cd.projectEnd ?? '—'}`
    parts.push(`<text x="${CONTENT_W/2}" y="${TITLE_H - 2}" text-anchor="middle" font-size="9" fill="#6b7280">${escXml(dateLine)}</text>`)
  }
  const hy = TITLE_H
  parts.push(`<rect x="0" y="${hy}" width="${CONTENT_W}" height="${HDR_H}" fill="#f9fafb"/>`)
  parts.push(`<line x1="0" y1="${hy + HDR_H}" x2="${CONTENT_W}" y2="${hy + HDR_H}" stroke="#d1d5db"/>`)
  for (const m of cd.months) {
    const x = m.startD * cd.colW
    const w = (m.endD - m.startD) * cd.colW
    parts.push(`<line x1="${x}" y1="${hy}" x2="${x}" y2="${hy + HDR_H}" stroke="#d1d5db"/>`)
    if (w > 30) {
      parts.push(`<text x="${x + w/2}" y="${hy + HDR_H - 7}" text-anchor="middle" font-size="${F_HDR}" font-weight="600" fill="#374151">${m.label}</text>`)
    }
  }
  parts.push(`<line x1="${CONTENT_W}" y1="${hy}" x2="${CONTENT_W}" y2="${hy + HDR_H}" stroke="#d1d5db"/>`)
  return parts.join('\n')
}

// ── Render rows [fromIdx, toIdx) at vertical offset bodyY ───────────────
function renderRows(cd: ChartData, fromIdx: number, toIdx: number, bodyY: number): string {
  const dateToX = (d: Date) => diffDays(cd.origin, d) * cd.colW
  const parts: string[] = []

  for (let i = fromIdx; i < toIdx; i++) {
    const row = cd.rows[i]
    const ri = i - fromIdx
    const ry = bodyY + ri * ROW_H

    // Ellipsis separator row
    if (row.isEllipsis) {
      parts.push(`<rect x="0" y="${ry}" width="${CONTENT_W}" height="${ROW_H}" fill="#f9fafb"/>`)
      parts.push(`<line x1="0" y1="${ry + ROW_H}" x2="${CONTENT_W}" y2="${ry + ROW_H}" stroke="#e5e7eb"/>`)
      const cy = ry + ROW_H / 2
      // Draw three dots and omitted count
      for (let di = -1; di <= 1; di++) {
        parts.push(`<circle cx="${CONTENT_W / 2 + di * 10}" cy="${cy}" r="2" fill="#9ca3af"/>`)
      }
      parts.push(`<text x="${CONTENT_W / 2 + 22}" y="${cy + F_BAR * 0.35}" font-size="${F_BAR}" fill="#9ca3af">省略 ${row.count} 个任务</text>`)
      continue
    }

    const t = row.task
    const isSumm = cd.summarySet.has(t.id)
    const pct = t.percent_done ?? 0

    if (ri % 2 === 1) parts.push(`<rect x="0" y="${ry}" width="${CONTENT_W}" height="${ROW_H}" fill="#fafafa"/>`)
    for (const m of cd.months) {
      parts.push(`<line x1="${m.startD * cd.colW}" y1="${ry}" x2="${m.startD * cd.colW}" y2="${ry + ROW_H}" stroke="#f0f0f0"/>`)
    }
    parts.push(`<line x1="0" y1="${ry + ROW_H}" x2="${CONTENT_W}" y2="${ry + ROW_H}" stroke="#e5e7eb"/>`)

    if (t.start_date && t.end_date) {
      const s = sod(new Date(t.start_date))
      const e = sod(new Date(t.end_date))
      const bx = dateToX(s)
      const bw = Math.max(diffDays(s, e) * cd.colW, 3)
      const by = ry + BAR_TOP

      if (t.is_milestone) {
        const mx = bx, my = by + BAR_H / 2, r = 5
        parts.push(`<polygon points="${mx},${my-r} ${mx+r},${my} ${mx},${my+r} ${mx-r},${my}" fill="#f59e0b" stroke="#d97706" stroke-width="0.8"/>`)
        const labelW = t.name.length * F_BAR * 0.6
        if (mx + r + 3 + labelW > CONTENT_W) {
          parts.push(`<text x="${mx - r - 3}" y="${my + F_BAR * 0.35}" text-anchor="end" font-size="${F_BAR}" fill="#92400e" font-weight="500">${escXml(t.name)}</text>`)
        } else {
          parts.push(`<text x="${mx + r + 3}" y="${my + F_BAR * 0.35}" font-size="${F_BAR}" fill="#92400e" font-weight="500">${escXml(t.name)}</text>`)
        }
      } else if (isSumm) {
        const sh = 5, sy = by + (BAR_H - sh) / 2
        parts.push(`<rect x="${bx}" y="${sy}" width="${bw}" height="${sh}" rx="1" fill="#60a5fa"/>`)
        parts.push(`<polygon points="${bx},${sy} ${bx+4},${sy} ${bx},${sy+sh}" fill="#60a5fa"/>`)
        parts.push(`<polygon points="${bx+bw-4},${sy} ${bx+bw},${sy} ${bx+bw},${sy+sh}" fill="#60a5fa"/>`)
        const labelW = t.name.length * F_BAR * 0.6
        if (bx + labelW > CONTENT_W) {
          parts.push(`<text x="${bx + bw}" y="${sy - 2}" text-anchor="end" font-size="${F_BAR}" fill="#1d4ed8" font-weight="600">${escXml(t.name)}</text>`)
        } else {
          parts.push(`<text x="${bx}" y="${sy - 2}" font-size="${F_BAR}" fill="#1d4ed8" font-weight="600">${escXml(t.name)}</text>`)
        }
      } else {
        parts.push(`<rect x="${bx}" y="${by}" width="${bw}" height="${BAR_H}" rx="2" fill="#93c5fd" stroke="#60a5fa" stroke-width="0.5"/>`)
        if (pct > 0) {
          parts.push(`<rect x="${bx}" y="${by}" width="${Math.round(bw * pct / 100)}" height="${BAR_H}" rx="2" fill="#3b82f6" opacity="0.7"/>`)
        }
        const label = escXml(t.name)
        const labelW = t.name.length * F_LABEL * 0.6
        if (bw > F_LABEL * t.name.length * 0.7) {
          parts.push(`<text x="${bx + 3}" y="${by + BAR_H/2 + F_BAR * 0.35}" font-size="${F_BAR}" fill="white" font-weight="500">${label}</text>`)
        } else if (bx + bw + 3 + labelW > CONTENT_W) {
          parts.push(`<text x="${bx - 3}" y="${by + BAR_H/2 + F_LABEL * 0.35}" text-anchor="end" font-size="${F_LABEL}" fill="#374151">${label}</text>`)
        } else {
          parts.push(`<text x="${bx + bw + 3}" y="${by + BAR_H/2 + F_LABEL * 0.35}" font-size="${F_LABEL}" fill="#374151">${label}</text>`)
        }
      }
    }
  }
  return parts.join('\n')
}

// ── Render dependency arrows (only for visible row range) ───────────────
function renderDeps(cd: ChartData, fromIdx: number, toIdx: number, bodyY: number): string {
  const dateToX = (d: Date) => diffDays(cd.origin, d) * cd.colW
  // Build row index mapping only for non-ellipsis rows
  const rowIndex: Record<string, number> = {}
  cd.rows.forEach((r, i) => { if (!r.isEllipsis) rowIndex[r.task.id] = i })
  const taskMap: Record<string, Task> = {}
  cd.activeTasks.forEach(t => { taskMap[t.id] = t })

  const parts: string[] = []
  parts.push(`<defs><marker id="exp-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="4" markerHeight="4" orient="auto"><path d="M0,0 L8,4 L0,8 Z" fill="#9ca3af"/></marker></defs>`)

  for (const dep of cd.dependencies) {
    const fi = rowIndex[dep.from_task_id]; const ti = rowIndex[dep.to_task_id]
    if (fi === undefined || ti === undefined) continue
    if (fi >= toIdx && ti >= toIdx) continue
    if (fi < fromIdx && ti < fromIdx) continue
    const ft = taskMap[dep.from_task_id]; const tt = taskMap[dep.to_task_id]
    if (!ft?.end_date || !tt?.start_date) continue
    const fromEnd = dateToX(sod(new Date(ft.end_date)))
    const toStart = dateToX(sod(new Date(tt.start_date)))
    const fy = bodyY + (fi - fromIdx) * ROW_H + ROW_H / 2
    const ty = bodyY + (ti - fromIdx) * ROW_H + ROW_H / 2
    const mx = fromEnd + 6
    parts.push(`<path d="M${fromEnd},${fy} L${mx},${fy} L${mx},${ty} L${toStart},${ty}" fill="none" stroke="#9ca3af" stroke-width="0.8" marker-end="url(#exp-arrow)"/>`)
  }
  return parts.join('\n')
}

// ── Render vertical lines (project start/end, status date, project lines) ──
function renderVerticalLines(cd: ChartData, topY: number, bottomY: number): string {
  const dateToX = (d: Date) => diffDays(cd.origin, d) * cd.colW
  const parts: string[] = []
  // 项目开工 / 完工日期：红色虚线（优先使用项目定义日期，回退到任务极值）
  const psStr = cd.projectStartDefined ?? cd.projectStart
  const peStr = cd.projectEndDefined ?? cd.projectEnd
  if (psStr) {
    const px = dateToX(sod(new Date(psStr)))
    parts.push(`<line x1="${px}" y1="${topY}" x2="${px}" y2="${bottomY}" stroke="#dc2626" stroke-width="1" stroke-dasharray="4,3"/>`)
    parts.push(`<text x="${px + 2}" y="${topY + 8}" font-size="7" fill="#dc2626" font-weight="600">开工 ${escXml(psStr)}</text>`)
  }
  if (peStr) {
    const px = dateToX(sod(new Date(peStr)))
    parts.push(`<line x1="${px}" y1="${topY}" x2="${px}" y2="${bottomY}" stroke="#dc2626" stroke-width="1" stroke-dasharray="4,3"/>`)
    parts.push(`<text x="${px - 2}" y="${topY + 8}" text-anchor="end" font-size="7" fill="#dc2626" font-weight="600">完工 ${escXml(peStr)}</text>`)
  }
  if (cd.statusDate) {
    const sx = dateToX(sod(new Date(cd.statusDate)))
    parts.push(`<line x1="${sx}" y1="${topY}" x2="${sx}" y2="${bottomY}" stroke="#ef4444" stroke-width="1" stroke-dasharray="3,2"/>`)
    parts.push(`<text x="${sx}" y="${topY + 16}" text-anchor="middle" font-size="7" fill="#ef4444">状态日期</text>`)
  }
  if (cd.projectLines) {
    for (const pl of cd.projectLines) {
      if (!pl.visible || !pl.line_date) continue
      const px = dateToX(sod(new Date(pl.line_date)))
      parts.push(`<line x1="${px}" y1="${topY}" x2="${px}" y2="${bottomY}" stroke="${pl.color}" stroke-width="1" stroke-dasharray="4,2"/>`)
      parts.push(`<text x="${px + 2}" y="${topY + 16}" font-size="7" fill="${pl.color}">${escXml(pl.name)}</text>`)
    }
  }
  return parts.join('\n')
}

// ── Build single-page SVG (key tasks already filtered to fit one A4 page) ──
function buildSinglePageSvg(cd: ChartData): { svg: string; width: number; height: number } {
  const bodyH  = cd.rows.length * ROW_H
  const bodyY  = TITLE_H + HDR_H
  const pageBottomY = bodyY + bodyH

  const parts: string[] = []
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${A4W}" height="${A4H}" viewBox="0 0 ${A4W} ${A4H}" style="font-family:system-ui,-apple-system,sans-serif">`)
  parts.push(`<rect width="${A4W}" height="${A4H}" fill="white"/>`)
  parts.push(`<g transform="translate(${MARGIN},${MARGIN})">`)
  parts.push(renderHeader(cd))
  parts.push(renderRows(cd, 0, cd.rows.length, bodyY))
  parts.push(renderDeps(cd, 0, cd.rows.length, bodyY))
  parts.push(renderVerticalLines(cd, TITLE_H, pageBottomY))
  parts.push('</g></svg>')
  return { svg: parts.join('\n'), width: A4W, height: A4H }
}

// ── Render SVG to canvas ────────────────────────────────────────────────
async function svgToCanvas(svgStr: string, svgW: number, svgH: number, dpi: number): Promise<HTMLCanvasElement> {
  const cw = Math.round(svgW * dpi)
  const ch = Math.round(svgH * dpi)
  const canvas = document.createElement('canvas')
  canvas.width = cw; canvas.height = ch
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, cw, ch)

  const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  await new Promise<void>((resolve, reject) => {
    const img = new Image()
    img.onload = () => { ctx.drawImage(img, 0, 0, cw, ch); URL.revokeObjectURL(url); resolve() }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('SVG rendering failed')) }
    img.src = url
  })
  return canvas
}

// ── Export as JPEG (single A4 page with key tasks) ─────────────────────
export async function exportToJpeg(
  tasks: Task[], dependencies: Dependency[], projectName: string,
  statusDate?: string | null, projectLines?: ProjectLine[],
  projectStartDate?: string | null, projectEndDate?: string | null,
) {
  const cd = prepareChartData(tasks, dependencies, projectName, statusDate, projectLines, false, projectStartDate, projectEndDate)
  const { svg, width, height } = buildSinglePageSvg(cd)
  const canvas = await svgToCanvas(svg, width, height, 3)
  const jpegData = canvas.toDataURL('image/jpeg', 0.92)
  const a = document.createElement('a')
  a.href = jpegData
  a.download = `${projectName || '甘特图'}_${new Date().toISOString().split('T')[0]}.jpg`
  a.click()
}

// ── Build one page SVG for multi-page export ──────────────────────────
function buildPageSvg(cd: ChartData, fromIdx: number, toIdx: number, pageNum: number, totalPages: number): string {
  const rowCount = toIdx - fromIdx
  const bodyY = TITLE_H + HDR_H
  const bodyH = rowCount * ROW_H
  const pageBottomY = bodyY + bodyH

  const parts: string[] = []
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${A4W}" height="${A4H}" viewBox="0 0 ${A4W} ${A4H}" style="font-family:system-ui,-apple-system,sans-serif">`)
  parts.push(`<rect width="${A4W}" height="${A4H}" fill="white"/>`)
  parts.push(`<g transform="translate(${MARGIN},${MARGIN})">`)
  parts.push(renderHeader(cd))
  parts.push(renderRows(cd, fromIdx, toIdx, bodyY))
  parts.push(renderDeps(cd, fromIdx, toIdx, bodyY))
  parts.push(renderVerticalLines(cd, TITLE_H, pageBottomY))
  // Page number
  if (totalPages > 1) {
    parts.push(`<text x="${CONTENT_W}" y="${A4H - MARGIN * 2 - 4}" text-anchor="end" font-size="8" fill="#9ca3af">${pageNum} / ${totalPages}</text>`)
  }
  parts.push('</g></svg>')
  return parts.join('\n')
}

// ── Export as PDF (multi-page, all tasks) ─────────────────────────────
export async function exportToPdf(
  tasks: Task[], dependencies: Dependency[], projectName: string,
  statusDate?: string | null, projectLines?: ProjectLine[],
  projectStartDate?: string | null, projectEndDate?: string | null,
) {
  const cd = prepareChartData(tasks, dependencies, projectName, statusDate, projectLines, true, projectStartDate, projectEndDate)
  const dpi = 3

  // Calculate rows per page
  const pageBodyH = A4H - MARGIN * 2 - TITLE_H - HDR_H
  const rowsPerPage = Math.max(Math.floor(pageBodyH / ROW_H), 6)
  const totalRows = cd.rows.length
  const totalPages = Math.max(Math.ceil(totalRows / rowsPerPage), 1)

  const { jsPDF } = await import('jspdf')
  const pdf = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' })

  for (let p = 0; p < totalPages; p++) {
    if (p > 0) pdf.addPage()
    const fromIdx = p * rowsPerPage
    const toIdx = Math.min(fromIdx + rowsPerPage, totalRows)
    const svg = buildPageSvg(cd, fromIdx, toIdx, p + 1, totalPages)
    const canvas = await svgToCanvas(svg, A4W, A4H, dpi)
    const imgData = canvas.toDataURL('image/jpeg', 0.92)
    pdf.addImage(imgData, 'JPEG', 0, 0, A4W, A4H)
  }

  pdf.save(`${projectName || '甘特图'}_${new Date().toISOString().split('T')[0]}.pdf`)
}
