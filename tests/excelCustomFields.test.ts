import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import * as XLSX from 'xlsx'
import { parseExcelFile } from '../lib/client/excelImport'
import { CUSTOM_FIELDS_SHEET } from '../lib/taskCustomFields'
import type { TaskCustomField } from '../types'

function file(sheet: XLSX.WorkSheet, metadata?: unknown[]) {
  const wb = XLSX.utils.book_new()
  // Configuration may be moved ahead of the task sheet by an Excel editor.
  if (metadata) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(metadata), CUSTOM_FIELDS_SHEET)
  XLSX.utils.book_append_sheet(wb, sheet, '任务')
  return new File([XLSX.write(wb, { type: 'array', bookType: 'xlsx' })], '属性.xlsx')
}

test('ordinary Excel columns become typed attributes and retain formatted identifiers, exact money and blank versus zero', async () => {
  const sheet = XLSX.utils.aoa_to_sheet([
    ['任务编码', '任务名称', '支出金额（元）', '合同编号', '付款日期', '合同(副本)'],
    ['1', '采购', '999999999999999999.99', 123, '2026-11-07', '原文'],
    ['2', '零金额', 0, '', '', ''],
    ['3', '未填', '', '', '', ''],
  ])
  sheet.D2.z = '000000'
  const result = await parseExcelFile(file(sheet))
  const fields = result.customFields!
  assert.deepEqual(fields.map(f => [f.name, f.type, f.unit]), [
    ['支出金额', 'money', '元'], ['合同编号', 'text', undefined], ['付款日期', 'date', undefined], ['合同(副本)', 'text', undefined],
  ])
  const [money, text, date] = fields
  assert.equal(result.tasks[0].custom_values![money.id], '999999999999999999.99')
  assert.equal(result.tasks[1].custom_values![money.id], '0.00')
  assert.equal(result.tasks[2].custom_values![money.id], undefined)
  assert.deepEqual(result.tasks[2].custom_fields, [], 'blank ordinary cells do not define attributes on unrelated tasks')
  assert.deepEqual(result.tasks[1].custom_fields, [money], 'zero is a filled monetary attribute')
  assert.equal(result.tasks[0].custom_values![text.id], '000123')
  assert.equal(result.tasks[0].custom_values![date.id], '2026-11-07')
})

test('Excel uses project definitions for numbers and choices, and rejects invalid choices or unsafe numeric money', async () => {
  const quantity: TaskCustomField = { id: randomUUID(), name: '数量', type: 'number', unit: '台' }
  const choice: TaskCustomField = { id: randomUUID(), name: '验收状态', type: 'select', options: ['合格', '待验收'] }
  const sheet = XLSX.utils.json_to_sheet([{ '任务编码': '1', '任务名称': '设备', '数量（台）': '1.12345678', '验收状态': '合格' }])
  const options = { customFields: [quantity, choice] }
  const result = await parseExcelFile(file(sheet), options)
  assert.deepEqual(result.customFields, [quantity, choice])
  assert.deepEqual(result.tasks[0].custom_values, { [quantity.id]: '1.12345678', [choice.id]: '合格' })
  sheet.D2.v = '不存在'
  await assert.rejects(parseExcelFile(file(sheet), options), /有效选项/)
  const unsafe = XLSX.utils.json_to_sheet([{ '任务编码': '1', '任务名称': '设备', '支出金额': 9999999999999999 }])
  await assert.rejects(parseExcelFile(file(unsafe)), /改为文本/)
})

test('Excel preserves hidden definitions and detects additional columns, duplicate headers and missing defined columns', async () => {
  const money: TaskCustomField = { id: randomUUID(), name: '支出金额', type: 'money', unit: '元' }
  const metadata = [{ '列名': '属性：支出金额（元）', '配置': JSON.stringify(money) }]
  const sheet = XLSX.utils.aoa_to_sheet([['任务编码', '任务名称', '属性：支出金额（元）', '备注属性'], ['1', '采购', '-12.30', '已签收']])
  const result = await parseExcelFile(file(sheet, metadata))
  assert.deepEqual(result.customFields![0], money)
  assert.equal(result.customFields![1].name, '备注属性')
  assert.equal(result.tasks[0].custom_values![money.id], '-12.30')
  const duplicate = XLSX.utils.aoa_to_sheet([['任务编码', '任务名称', '附加列', '附加列'], ['1', '采购', 'a', 'b']])
  await assert.rejects(parseExcelFile(file(duplicate)), /列名重复/)
  await assert.rejects(parseExcelFile(file(duplicate, metadata)), /列名重复/)
  const missing = XLSX.utils.aoa_to_sheet([['任务编码', '任务名称'], ['1', '采购']])
  await assert.rejects(parseExcelFile(file(missing, metadata)), /缺少属性列/)
  const spacer = XLSX.utils.aoa_to_sheet([['任务编码', '任务名称', undefined, '普通属性'], ['1', '采购', undefined, '保留']])
  assert.equal((await parseExcelFile(file(spacer))).customFields![0].name, '普通属性')
})
