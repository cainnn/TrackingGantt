import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as XLSX from 'xlsx'
import * as clientTime from '../lib/clientTime'
import { parseExcelFile } from '../lib/client/excelImport'
import type { Task, Dependency } from '../types'

// 执行真实导出代码和 ExcelJS，仅替换浏览器下载与无关的 React 状态计算依赖。
function loadExporter() {
  const saved: Blob[] = []
  const source = readFileSync(resolve(__dirname, '../../lib/client/excelExport.ts'), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText
  const output: { exportToExcel?: (
    tasks: Task[], deps: Dependency[], name: string, statusDate?: string | null,
    lines?: [], options?: { isMinute?: boolean },
  ) => Promise<void> } = {}
  const requireActual = createRequire(__filename)
  runInNewContext(compiled, {
    exports: output,
    Blob,
    require: (name: string) => {
      if (name === 'file-saver') return { saveAs: (blob: Blob) => saved.push(blob) }
      if (name === '@/lib/clientTime') return clientTime
      if (name === '@/components/GanttChart/GanttChart') return {
        computeTaskStatus: () => ({ status: 'notstarted', reason: '' }),
        STATUS_META: { notstarted: { label: '未开始' } },
      }
      return requireActual(name)
    },
  })
  assert.ok(output.exportToExcel)
  return { exportToExcel: output.exportToExcel, saved }
}

function task(id: string, duration: number, parentId: string | null = null): Task {
  return {
    id, project_id: 'excel-test', task_code: id, name: `任务${id}`, parent_id: parentId,
    assignee: '张三', start_date: '2026-06-01T00:00:00', end_date: '2026-06-04T00:00:00',
    duration, duration_unit: 'minute', percent_done: 0, is_milestone: duration === 0,
    note: null, order_index: Number(id), is_deleted: false, deleted_at: null,
    created_at: '2026-06-01T00:00:00', updated_at: '2026-06-01T00:00:00',
  }
}

test('exports days by default on main and assignee sheets and imports without changing durations', async () => {
  const { exportToExcel, saved } = loadExporter()
  const tasks = [task('1', 4320), task('2', 2880, '1'), task('3', 0, '1')]
  const deps: Dependency[] = [{
    id: 'dep', project_id: 'excel-test', from_task_id: '2', to_task_id: '3', type: 2, lag: 1440,
  }]

  for (const options of [undefined, { isMinute: false }]) {
    await exportToExcel(tasks, deps, '天级项目', undefined, undefined, options)
    const blob = saved[saved.length - 1]
    const wb = XLSX.read(await blob.arrayBuffer())
    assert.deepEqual(wb.SheetNames, ['任务', '张三'])
    for (const name of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[name])
      assert.deepEqual(rows.map(row => row['工期(天)']), [3, 2, 0])
      assert.equal(rows[0]['工期(分钟)'], undefined)
      assert.equal(rows[2]['延迟'], 1)
    }
    const parsed = await parseExcelFile(new File([blob], 'days.xlsx'), options)
    assert.deepEqual(parsed.tasks.map(t => t.duration), tasks.map(t => t.duration))
    assert.equal(parsed.dependencies[0].lag, 1440)
    assert.equal(parsed.tasks[1].parent_task_code, '1')
    assert.equal(parsed.tasks[2].is_milestone, true)
  }
  assert.deepEqual(tasks.map(t => t.duration), [4320, 2880, 0])
})

test('labels minute projects explicitly and keeps subsequent day exports in days', async () => {
  const { exportToExcel, saved } = loadExporter()
  const tasks = [task('1', 75), task('2', 30), task('3', 0)]
  const deps: Dependency[] = [{
    id: 'dep', project_id: 'excel-test', from_task_id: '1', to_task_id: '2', type: 2, lag: 15,
  }]
  await exportToExcel(tasks, deps, '分钟级项目', '2026-06-01T09:30:00', undefined, { isMinute: true })
  const blob = saved[0]
  const wb = XLSX.read(await blob.arrayBuffer())
  for (const name of ['任务', '张三']) {
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[name])
    assert.deepEqual(rows.map(row => row['工期(分钟)']), [75, 30, 0])
    assert.equal(rows[0]['工期(天)'], undefined)
    assert.equal(rows[1]['延迟'], 15)
  }
  const parsed = await parseExcelFile(new File([blob], 'minutes.xlsx'), { isMinute: true })
  assert.deepEqual(parsed.tasks.map(t => t.duration), [75, 30, 0])
  assert.equal(parsed.dependencies[0].lag, 15)
  assert.equal(parsed.statusDate, '2026-06-01T09:30:00')
  const defaultParsed = await parseExcelFile(new File([blob], 'minutes.xlsx'))
  assert.equal(defaultParsed.dependencies[0].lag, 15)

  await exportToExcel([task('1', 1440)], [], '天级项目')
  const dayWorkbook = XLSX.read(await saved[1].arrayBuffer())
  const dayRows = XLSX.utils.sheet_to_json<Record<string, unknown>>(dayWorkbook.Sheets['任务'])
  assert.equal(dayRows[0]['工期(天)'], 1)
  assert.equal(dayRows[0]['工期(分钟)'], undefined)
})
