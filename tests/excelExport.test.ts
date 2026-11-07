import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'
import * as XLSX from 'xlsx'
import * as clientTime from '../lib/clientTime'
import * as taskCustomFields from '../lib/taskCustomFields'
import * as taskAttributeTransfer from '../lib/taskAttributeTransfer'
import { parseExcelFile } from '../lib/client/excelImport'
import type { Task, Dependency, TaskCustomField } from '../types'

// 执行真实导出代码和 ExcelJS，仅替换浏览器下载与无关的 React 状态计算依赖。
function loadExporter() {
  const saved: Blob[] = []
  const source = readFileSync(resolve(__dirname, '../../lib/client/excelExport.ts'), 'utf8')
  const compiled = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText
  const output: { exportToExcel?: (
    tasks: Task[], deps: Dependency[], name: string, statusDate?: string | null,
    lines?: [], options?: { isMinute?: boolean; customFields?: TaskCustomField[] },
  ) => Promise<void> } = {}
  const requireActual = createRequire(__filename)
  runInNewContext(compiled, {
    exports: output,
    Blob,
    require: (name: string) => {
      if (name === 'file-saver') return { saveAs: (blob: Blob) => saved.push(blob) }
      if (name === '@/lib/clientTime') return clientTime
      if (name === '../taskCustomFields') return taskCustomFields
      if (name === '../taskAttributeTransfer') return taskAttributeTransfer
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
    assert.deepEqual(wb.SheetNames, ['任务', '张三', taskAttributeTransfer.TASK_FIELDS_SHEET])
    assert.equal(wb.Workbook?.Sheets?.find(s => s.name === taskAttributeTransfer.TASK_FIELDS_SHEET)?.Hidden, 1)
    for (const name of ['任务', '张三']) {
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

test('exports actual custom columns as exact text and reimports their definitions and values', async () => {
  const { exportToExcel, saved } = loadExporter()
  const money: TaskCustomField = { id: '00000000-0000-4000-8000-000000000001', name: '支出金额', type: 'money', unit: '元' }
  const choice: TaskCustomField = { id: '00000000-0000-4000-8000-000000000002', name: '付款状态', type: 'select', options: ['未付款', '已付款'] }
  const items = [
    { ...task('1', 1440), custom_values: { [money.id]: '999999999999999999.99', [choice.id]: '已付款' } },
    { ...task('2', 1440), custom_values: { [money.id]: '0.00', [choice.id]: '' } },
    { ...task('3', 1440), custom_values: {} },
  ]
  await exportToExcel(items, [], '自定义属性', null, undefined, { customFields: [money, choice] })
  const workbook = XLSX.read(await saved[0].arrayBuffer())
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets['任务'])
  assert.equal(rows[0]['属性：支出金额（元）'], '999999999999999999.99')
  assert.equal(rows[1]['属性：支出金额（元）'], '0.00')
  assert.equal(workbook.Workbook?.Sheets?.find(s => s.name === taskCustomFields.CUSTOM_FIELDS_SHEET)?.Hidden, 1)
  const parsed = await parseExcelFile(new File([saved[0]], '属性.xlsx'))
  assert.deepEqual(parsed.customFields, [money, choice])
  assert.deepEqual(parsed.tasks[0].custom_values, items[0].custom_values)
  assert.deepEqual(parsed.tasks[1].custom_values, items[1].custom_values)
  assert.deepEqual(parsed.tasks[2].custom_values, {})
  assert.deepEqual(parsed.tasks[2].custom_fields, [], 'attributes on other tasks must not attach to an empty task')
})

test('Excel task-owned attributes roundtrip independently, including same names of different types and external edits', async () => {
  const { exportToExcel, saved } = loadExporter()
  const a: TaskCustomField = { id: '00000000-0000-4000-8000-000000000001', name: '自定值', type: 'money' }
  const b: TaskCustomField = { id: '00000000-0000-4000-8000-000000000002', name: '自定值', type: 'text' }
  const items = [
    { ...task('1', 1440), custom_fields: [a], custom_values: { [a.id]: '' } },
    { ...task('2', 1440), custom_fields: [b], custom_values: { [b.id]: '000123' } },
    { ...task('3', 1440), custom_fields: [], custom_values: {} },
  ]
  await exportToExcel(items, [], '独立属性')
  const parsed = await parseExcelFile(new File([saved[0]], '独立.xlsx'))
  parsed.tasks.forEach((t, i) => {
    assert.deepEqual(t.custom_fields, items[i].custom_fields)
    assert.deepEqual(t.custom_values, items[i].custom_values)
  })
  const workbook = XLSX.read(await saved[0].arrayBuffer())
  const sheet = workbook.Sheets['任务']
  const headers = XLSX.utils.sheet_to_json<string[]>(sheet, { header: 1 })[0]
  const moneyColumn = headers.indexOf('属性：自定值')
  assert.ok(moneyColumn >= 0)
  sheet[XLSX.utils.encode_cell({ r: 1, c: moneyColumn })] = { t: 's', v: '234.56' }
  const edited = await parseExcelFile(new File([XLSX.write(workbook, { type: 'array', bookType: 'xlsx' })], '修改.xlsx'))
  assert.equal(edited.tasks[0].custom_values?.[a.id], '234.56')
  assert.deepEqual(edited.tasks[1].custom_fields, [b])
  assert.deepEqual(edited.tasks[2].custom_fields, [])
})

test('large task attribute schemas span metadata cells without Excel truncation', async () => {
  const { exportToExcel, saved } = loadExporter()
  const fields: TaskCustomField[] = Array.from({ length: 6 }, (_, i) => ({
    id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, name: `自定义选项${i}`, type: 'select',
    options: Array.from({ length: 100 }, (_, j) => `${j}${'描述'.repeat(35)}`),
  }))
  await exportToExcel([{ ...task('1', 1440), custom_fields: fields, custom_values: {} }], [], '大属性配置')
  const workbook = XLSX.read(await saved[0].arrayBuffer())
  const parts = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[taskAttributeTransfer.TASK_FIELDS_SHEET])
  assert.ok(parts.length > 1)
  assert.ok(parts.every(part => String(part['归属']).length <= 20_000))
  const parsed = await parseExcelFile(new File([saved[0]], '大配置.xlsx'))
  assert.deepEqual(parsed.tasks[0].custom_fields, fields)
})
