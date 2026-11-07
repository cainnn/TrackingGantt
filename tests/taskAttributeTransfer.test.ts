import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { prepareTaskAttributeTransfer, restoreTaskAttributes } from '../lib/taskAttributeTransfer'
import { taskCustomFields, mergeTaskAttributes, submittedTaskCustomFields, restoreTaskAttributeSnapshot } from '../lib/taskCustomFields'
import { buildSaveDiff, mergeSavedRecords } from '../lib/clientSave'
import { diffSnapshots } from '../lib/versionDiff'
import type { Task, TaskCustomField } from '../types'

const field = (name: string, type: TaskCustomField['type'] = 'text'): TaskCustomField => ({ id: randomUUID(), name, type })
test('task ownership attaches only actual legacy values and keeps independent names/types', () => {
  const amount = field('金额', 'money'), other = field('金额')
  assert.deepEqual(taskCustomFields({}, [amount]), [])
  assert.deepEqual(taskCustomFields({ custom_values: { [amount.id]: '' } }, [amount]), [amount])
  assert.deepEqual(taskCustomFields({ custom_fields: [other] }, [amount]), [other])
  assert.deepEqual(submittedTaskCustomFields({ custom_fields: [other], custom_values: { [other.id]: '自定义' } }, {}, [amount]), [other])
  const old = { custom_fields: [amount], custom_values: { [amount.id]: '12.50' } }
  assert.deepEqual(mergeTaskAttributes({}, old), old, 'legacy files without attributes must preserve existing data')
  const renamed = { ...amount, name: '付款' }
  assert.deepEqual(mergeTaskAttributes({ custom_fields: [renamed], custom_values: { [amount.id]: '' } }, old), { custom_fields: [renamed], custom_values: { [amount.id]: '' } })
})
test('file transfer shares equivalent columns but restores independent IDs, empty membership and edited values', () => {
  const a = field('自定义金额', 'money'), b = field('自定义金额', 'money'), c = field('自定义金额')
  const input = [
    { custom_fields: [a], custom_values: { [a.id]: '999999999999999999.99' } },
    { custom_fields: [b], custom_values: { [b.id]: '' } },
    { custom_fields: [c], custom_values: { [c.id]: '待核对' } },
    { custom_fields: [], custom_values: {} },
  ]
  const transfer = prepareTaskAttributeTransfer(input)
  assert.equal(transfer.fields.length, 2)
  assert.equal(transfer.tasks[1].custom_field_binding.columns[b.id], a.id)
  transfer.tasks.forEach((task, i) => assert.deepEqual(restoreTaskAttributes(task.custom_values, transfer.fields, task.custom_field_binding), input[i]))
  const edited = restoreTaskAttributes({ [a.id]: '0.00' }, transfer.fields, transfer.tasks[1].custom_field_binding)
  assert.deepEqual(edited, { custom_fields: [b], custom_values: { [b.id]: '0.00' } })
  assert.equal(input[1].custom_values[b.id], '', 'export/import must not mutate source tasks')
})
test('new file columns apply to filled tasks; missing ownership columns fail instead of losing data', () => {
  const a = field('备注属性'), added = field('验收人')
  const transfer = prepareTaskAttributeTransfer([{ custom_fields: [a], custom_values: {} }])
  const binding = transfer.tasks[0].custom_field_binding
  assert.throws(() => restoreTaskAttributes({}, [], binding), /缺失/)
  assert.deepEqual(restoreTaskAttributes({}, [a, added], binding).custom_fields, [a])
  assert.deepEqual(restoreTaskAttributes({ [added.id]: '张三' }, [a, added], binding).custom_fields, [a, added])
})
test('schema-only task edits are saved/reviewed and later local changes survive a save response', () => {
  const a = field('自定义编号')
  const base = { id: 't', project_id: 'p', task_code: '31', name: '任务', duration: null, custom_fields: [], custom_values: {} } as unknown as Task
  const submitted = { ...base, custom_fields: [a] }
  assert.deepEqual(buildSaveDiff([base], [], [submitted], []).tasksToUpdate, [submitted])
  assert.ok(diffSnapshots([base], [submitted])[0]?.changes?.some(c => c.field === '任务属性配置'))
  const current = { ...submitted, custom_fields: [{ ...a, name: '合同编号' }] }
  assert.deepEqual(mergeSavedRecords([submitted], [submitted], [current])[0].custom_fields, current.custom_fields)
})

test('local version rollback restores own definitions and values, archives newer fields and preserves legacy omissions', () => {
  const a = field('历史名称'), b = field('较新属性')
  const snapshot = { custom_fields: [a], custom_values: { [a.id]: '历史值' } }
  const current = { custom_fields: [{ ...a, name: '新名称' }, b], custom_values: { [a.id]: '新值', [b.id]: '保留数据' } }
  assert.deepEqual(restoreTaskAttributeSnapshot(snapshot, current), {
    custom_fields: [a, { ...b, archived: true }], custom_values: { [a.id]: '历史值', [b.id]: '保留数据' },
  })
  assert.deepEqual(restoreTaskAttributeSnapshot({}, current), current)
})
