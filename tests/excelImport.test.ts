import test from 'node:test'
import assert from 'node:assert/strict'
import * as XLSX from 'xlsx'
import { parseExcelFile, validateImportData } from '../lib/client/excelImport'

test('imports exported Excel headers with datetime dates and minute duration', async () => {
  const wb = XLSX.utils.book_new()
  const taskSheet = XLSX.utils.json_to_sheet([
    {
      '任务编码': '1',
      '层级': 1,
      '父任务编码': '',
      '任务名称': '准备',
      '开始日期': '2026-06-04 09:30',
      '结束日期': '2026-06-04 10:45',
      '工期(分钟)': 75,
      '里程碑': '否',
      '自动排程': '是',
      '前置依赖': '',
    },
    {
      '任务编码': '2',
      '层级': 1,
      '父任务编码': '',
      '任务名称': '上线',
      '开始日期': '2026-06-04 10:45',
      '结束日期': '2026-06-04 11:15',
      '工期(分钟)': 30,
      '里程碑': '否',
      '自动排程': '是',
      '前置依赖': '1FS',
    },
  ])
  const settingsSheet = XLSX.utils.json_to_sheet([
    { '类型': '状态时间', '名称': '状态时间', '日期': '2026-06-04 10:00' },
  ])
  XLSX.utils.book_append_sheet(wb, taskSheet, '任务')
  XLSX.utils.book_append_sheet(wb, settingsSheet, '项目设置')

  const data = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
  const file = new File([data], 'import.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })

  const parsed = await parseExcelFile(file)

  assert.equal(parsed.tasks.length, 2)
  assert.equal(parsed.tasks[0].start_date, '2026-06-04T09:30:00')
  assert.equal(parsed.tasks[0].end_date, '2026-06-04T10:45:00')
  assert.equal(parsed.tasks[0].duration, 75)
  assert.equal(parsed.statusDate, '2026-06-04T10:00:00')
  assert.deepEqual(parsed.dependencies, [
    { from_task_code: '1', to_task_code: '2', type: 2, lag: 0, active: true },
  ])
  assert.deepEqual(validateImportData(parsed.tasks, parsed.dependencies), [])
})

test('imports predecessor lag using project granularity at Excel boundary', async () => {
  const wb = XLSX.utils.book_new()
  const taskSheet = XLSX.utils.json_to_sheet([
    { '任务编码': '1', '层级': 1, '任务名称': '准备', '开始日期': '2026-06-01', '结束日期': '2026-06-02', '工期(分钟)': 1440 },
    { '任务编码': '2', '层级': 1, '任务名称': '上线', '开始日期': '2026-06-03', '结束日期': '2026-06-04', '工期(分钟)': 1440, '前置依赖': '1FS+2d' },
  ])
  XLSX.utils.book_append_sheet(wb, taskSheet, '任务')
  const data = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
  const file = new File([data], 'import.xlsx', {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  })

  const dayParsed = await parseExcelFile(file, { isMinute: false })
  const minuteParsed = await parseExcelFile(file, { isMinute: true })

  assert.equal(dayParsed.dependencies[0].lag, 2880)
  assert.equal(minuteParsed.dependencies[0].lag, 2880)
})

for (const isMinute of [false, true]) {
  test(`imports duration by column unit regardless of project granularity (minute=${isMinute})`, async () => {
    const values: [string, unknown, number | null][] = [
      ['工期(天)', 3, 4320],
      ['工期（天）', 1.5, 2160],
      ['工期', 2, 2880],
      ['工期(分钟)', 75, 75],
      ['工期（分钟）', 30, 30],
      ['工期(天)', 0, 0],
      ['工期(分钟)', 0, 0],
      ['工期(天)', '', null],
      ['工期(分钟)', '', null],
    ]
    const wb = XLSX.utils.book_new()
    const sheet = XLSX.utils.json_to_sheet(values.map(([header, duration], i) => ({
      '任务编码': String(i + 1),
      '任务名称': `任务${i + 1}`,
      [header]: duration,
    })))
    XLSX.utils.book_append_sheet(wb, sheet, '任务')
    const data = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
    const parsed = await parseExcelFile(new File([data], 'units.xlsx'), { isMinute })

    assert.deepEqual(parsed.tasks.map(t => t.duration), values.map(([, , expected]) => expected))
  })
}

test('imports a unitless duration as days by default', async () => {
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([
    { '任务编码': '1', '任务名称': '准备', '工期': 3 },
    { '任务编码': '2', '任务名称': '未填写工期' },
  ]), '任务')
  const data = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
  const parsed = await parseExcelFile(new File([data], 'default-days.xlsx'))

  assert.deepEqual(parsed.tasks.map(t => t.duration), [4320, null])
})
