import test from 'node:test'
import assert from 'node:assert/strict'
import { configureStore } from '@reduxjs/toolkit'
import { normalizeCustomFields, normalizeCustomValue, normalizeCustomValues, customFieldsEqual, customValuesEqual, customFieldExportColumns, mergeImportedCustomFields, CUSTOM_FIELDS_SHEET } from '../lib/taskCustomFields'
import { buildSaveDiff, mergeSavedRecords } from '../lib/clientSave'
import { diffSnapshots } from '../lib/versionDiff'
import { rootReducer, createDraftMiddleware, initializeDraft, snapshotDraft, hasDraftChanges, undoDraft, redoDraft, beginDraftSave, finishDraftSave, resetDraft } from '../store/draftHistory'
import { setCurrentProject, setCustomFields } from '../store/slices/projectSlice'
import { setTasks, updateTasks, setViewSnapshot } from '../store/slices/tasksSlice'
import { buildTaskCopies } from '../lib/clientTaskCopy'
import type { TaskCustomField, Task } from '../types'
import * as XLSX from 'xlsx'
import { parseExcelFile } from '../lib/client/excelImport'

const money: TaskCustomField = { id: '00000000-0000-4000-8000-000000000001', name: '支出金额', type: 'money', unit: '元' }
const text: TaskCustomField = { id: '00000000-0000-4000-8000-000000000002', name: '合同编号', type: 'text' }
const task: Task = { id: 'a', project_id: 'p', parent_id: null, task_code: '1', name: '设备到货', assignee: null,
  start_date: '2026-11-01T00:00:00', end_date: '2026-11-02T00:00:00', duration: 1440, duration_unit: 'minute',
  percent_done: 0, is_milestone: false, note: null, order_index: 0, is_deleted: false, deleted_at: null, created_at: '', updated_at: '' }

test('money is exact beyond JS integer precision, distinguishes zero and empty, and rejects invalid precision', () => {
  assert.equal(normalizeCustomValue('999999999999999999.99', money), '999999999999999999.99')
  assert.equal(normalizeCustomValue('00012.5', money), '12.50')
  assert.equal(normalizeCustomValue('-0', money), '0.00')
  assert.equal(normalizeCustomValue('-12.50', money), '-12.50')
  assert.equal(normalizeCustomValue('', money), '')
  for (const invalid of ['12.345', '1e9', 'NaN', 'Infinity', '1000000000000000000']) assert.throws(() => normalizeCustomValue(invalid, money))
})
test('custom fields validate names, unique IDs, immutable types, option retention and bounded input', () => {
  assert.throws(() => normalizeCustomFields([money, money]))
  assert.throws(() => normalizeCustomFields([money, { ...text, name: money.name }]))
  assert.throws(() => normalizeCustomFields([{ ...money, type: 'text' }], [money]))
  assert.throws(() => normalizeCustomFields([{ ...text, type: '__proto__' }]))
  const choice: TaskCustomField = { ...text, type: 'select', options: ['合同', '订单'] }
  assert.throws(() => normalizeCustomFields([{ ...choice, options: ['合同'] }], [choice]))
  assert.deepEqual(normalizeCustomFields([money], [money, text]), [money, text])
  assert.equal(normalizeCustomFields([{ ...money, name: '实际支出', archived: true }], [money])[0].id, money.id)
})
test('values validate dates, numbers and choices; partial and legacy updates preserve other fields', () => {
  const date: TaskCustomField = { ...text, type: 'date' }
  assert.equal(normalizeCustomValue('2028-02-29', date), '2028-02-29')
  assert.throws(() => normalizeCustomValue('2026-02-29', date))
  assert.equal(normalizeCustomValue('0012.500', { ...text, type: 'number' }), '12.5')
  assert.throws(() => normalizeCustomValue('未知', { ...text, type: 'select', options: ['已付款'] }))
  const previous = { [money.id]: '10.00', [text.id]: '合同001' }
  assert.deepEqual(normalizeCustomValues({ [money.id]: '' }, [money, text], previous), { ...previous, [money.id]: '' })
  assert.deepEqual(normalizeCustomValues({}, [money, text], previous), previous)
  assert.throws(() => normalizeCustomValues({ unknown: 'x' }, [money]))
  assert.deepEqual(normalizeCustomValues(previous, [{ ...money, archived: true }, text], previous), previous)
  assert.deepEqual(normalizeCustomValues(previous, [{ ...money, archived: true }, text]), previous)
})
test('attribute changes participate in save diff and named version review without changing scheduling', () => {
  const edited = { ...task, custom_values: { [money.id]: '0.00' } }
  assert.deepEqual(buildSaveDiff([task], [], [edited], []).tasksToUpdate, [edited])
  assert.deepEqual(diffSnapshots([task], [edited], { customFields: [money] })[0].changes, [{ field: '属性：支出金额', old: '(空)', new: '0.00 元' }])
  assert.equal(buildSaveDiff([edited], [], [{ ...edited, custom_values: { [text.id]: '', [money.id]: '0.00' } }], []).tasksToUpdate.length, 0)
  assert.equal(customValuesEqual({ a: '1', b: '' }, { a: '1' }), true)
  assert.equal(customFieldsEqual([money], [{ ...money, archived: false }]), true)
})
test('saving merges later attribute edits per key and keeps server normalization of other attributes', () => {
  const submitted = { ...task, custom_values: { [money.id]: '10', [text.id]: '旧' } }
  const saved = { ...task, custom_values: { [money.id]: '10.00', [text.id]: '旧' } }
  const current = { ...task, custom_values: { [money.id]: '10', [text.id]: '新' } }
  assert.deepEqual(mergeSavedRecords([saved], [submitted], [current])[0].custom_values, { [money.id]: '10.00', [text.id]: '新' })
  assert.deepEqual(mergeSavedRecords([], [saved], [{ ...saved, custom_values: { ...saved.custom_values } }]), [], 'equivalent object copies must not resurrect a deleted task')
})
test('task copies retain attributes, including archived values, without modifying the source', () => {
  const source = { ...task, custom_values: { [money.id]: '12000.50', [text.id]: '合同001' } }
  const copied = buildTaskCopies([source], [], [source.id], source.id, 'after').tasksToAdd[0]
  assert.deepEqual(copied.custom_values, source.custom_values)
  assert.notEqual(copied.id, source.id)
})
function storeFixture() {
  const store = configureStore({ reducer: rootReducer, middleware: get => get().concat(createDraftMiddleware()) })
  store.dispatch(setCurrentProject({ id: 'p', user_id: 'u', name: 'P', start_date: null, end_date: null, status_date: null, planning_status: 'draft', created_at: '' }))
  store.dispatch(setTasks({ tasks: [task], dependencies: [] }))
  store.dispatch(initializeDraft({ projectId: 'p', baseline: snapshotDraft(store.getState()) }))
  return store
}
test('configuration and values have separate undo steps; discard restores both, without persistence', async () => {
  const store = storeFixture(), base = snapshotDraft(store.getState())
  store.dispatch(setCustomFields({ projectId: 'p', fields: [money] }))
  await Promise.resolve()
  store.dispatch(updateTasks([{ ...task, custom_values: { [money.id]: '12.50' } }]))
  await Promise.resolve()
  assert.equal(store.getState().draft.past.length, 2)
  assert.equal(hasDraftChanges(store.getState()), true)
  store.dispatch(undoDraft())
  assert.equal(store.getState().tasks.tasks[0].custom_values, undefined)
  assert.deepEqual(store.getState().project.currentProject?.custom_fields, [money])
  store.dispatch(undoDraft())
  assert.equal(hasDraftChanges(store.getState()), false)
  store.dispatch(redoDraft()); store.dispatch(redoDraft()); store.dispatch(resetDraft(base))
  assert.equal(hasDraftChanges(store.getState()), false)
})
test('confirmed save is an undo boundary and retains newer attribute edits and new field definitions', async () => {
  const store = storeFixture()
  store.dispatch(setCustomFields({ projectId: 'p', fields: [money] }))
  store.dispatch(updateTasks([{ ...task, custom_values: { [money.id]: '12.50' } }]))
  store.dispatch(beginDraftSave())
  const saved = snapshotDraft(store.getState())
  store.dispatch(setCustomFields({ projectId: 'p', fields: [money, text] }))
  store.dispatch(updateTasks([{ ...task, custom_values: { [money.id]: '20.00' } }]))
  await Promise.resolve()
  store.dispatch(finishDraftSave(saved))
  assert.equal(store.getState().tasks.tasks[0].custom_values?.[money.id], '20.00')
  assert.deepEqual(store.getState().project.currentProject?.custom_fields, [money, text])
  store.dispatch(undoDraft())
  assert.equal(store.getState().tasks.tasks[0].custom_values?.[money.id], '12.50')
  assert.deepEqual(store.getState().project.currentProject?.custom_fields, [money])
  store.dispatch(undoDraft())
  assert.equal(hasDraftChanges(store.getState()), false)
})
test('history preview prevents changes to definitions and task values', () => {
  const store = storeFixture(), before = snapshotDraft(store.getState())
  store.dispatch(setViewSnapshot({ tasks: [task], dependencies: [], versionId: 'v', versionName: 'old' }))
  store.dispatch(setCustomFields({ projectId: 'p', fields: [money] }))
  store.dispatch(updateTasks([{ ...task, custom_values: { [money.id]: '99' } }]))
  assert.deepEqual(snapshotDraft(store.getState()), before)
})
test('Excel import matches existing definitions by name without duplicating them and keeps selected choices', () => {
  const other = { ...money, id: text.id }
  const result = mergeImportedCustomFields([money], [other])
  assert.deepEqual(result.fields, [money])
  assert.equal(result.idMap.get(text.id), money.id)
  assert.throws(() => mergeImportedCustomFields([money], [{ ...other, type: 'text' }]))
})
test('Excel roundtrip retains exact monetary text, zeros, dates and archived values with definitions', async () => {
  const fields = [money, { ...text, archived: true }]
  const columns = customFieldExportColumns(fields)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet([{ '任务编码': '1', '任务名称': '设备到货', [columns[0].header]: '999999999999999999.99', [columns[1].header]: '合同原文' }]), '任务')
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(columns.map(c => ({ '列名': c.header, '配置': JSON.stringify(c.field) }))), CUSTOM_FIELDS_SHEET)
  const parsed = await parseExcelFile(new File([XLSX.write(wb, { type: 'array', bookType: 'xlsx' })], '属性.xlsx'))
  assert.deepEqual(parsed.customFields, fields)
  assert.deepEqual(parsed.tasks[0].custom_values, { [money.id]: '999999999999999999.99', [text.id]: '合同原文' })
  delete wb.Sheets['任务'][XLSX.utils.encode_cell({ r: 0, c: 2 })]
  await assert.rejects(() => parseExcelFile(new File([XLSX.write(wb, { type: 'array', bookType: 'xlsx' })], '缺列.xlsx')), /缺少属性列/)
})
