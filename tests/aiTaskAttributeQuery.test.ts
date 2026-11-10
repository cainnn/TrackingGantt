import test from 'node:test'
import assert from 'node:assert/strict'
import type { Task, TaskCustomField } from '../types'
import { attributeQueryMessage, buildTaskAttributeCatalog, deduplicateAttributeReports, isTaskAttributeQueryIntent, queryTaskAttributes, queryTaskAttributeReports, type AttributeQuery, type AttributeQueryReport } from '../lib/ai/taskAttributeQuery'
import { resolveAttributeDateRange } from '../lib/ai/attributeDateRange'
import { AI_TOOLS, buildSystemPrompt } from '../lib/ai/tools'

const field = (id: string, patch: Partial<TaskCustomField> = {}): TaskCustomField => ({ id, name: '搬迁服务器台数', type: 'number', unit: '台', ...patch })
const task = (id: string, value: string | undefined, end = '2026-01-31', patch: Partial<Task> = {}): Task => ({
  id, project_id: 'p', parent_id: null, task_code: id, name: `搬迁-${id}`, assignee: '张三',
  start_date: '2025-12-01', end_date: end, duration: 1440, duration_unit: 'day', percent_done: 0,
  is_milestone: false, note: null, order_index: 0, is_deleted: false, deleted_at: null, created_at: '', updated_at: '',
  custom_fields: [field(`field-${id}`)], custom_values: value === undefined ? {} : { [`field-${id}`]: value }, ...patch,
})
const query = (tasks: Task[], patch: Partial<AttributeQuery> = {}, legacy: TaskCustomField[] = []): AttributeQueryReport => {
  const result = queryTaskAttributes(tasks, { attribute_name: '搬迁服务器台数', operation: 'sum', group_by: 'month', ...patch }, legacy)
  assert.equal(result.ok, true, JSON.stringify(result))
  return result
}

test('monthly sums use task end dates, separate years and count cross-month tasks once', () => {
  const tasks = [task('a', '12'), task('b', '8', '2026-03-01T00:00:00'), task('c', '5', '2027-01-01T23:59:00')]
  const before = structuredClone(tasks)
  const result = query(tasks)
  assert.equal(result.dateBasis, '任务结束日期')
  assert.equal(result.total, '25')
  assert.equal(result.matchedTasks, 3)
  assert.deepEqual(result.groups.slice(0, 3), [{ key: '2026-01', value: '12', tasks: 1 }, { key: '2026-02', value: '0', tasks: 0 }, { key: '2026-03', value: '8', tasks: 1 }])
  assert.deepEqual(result.groups.at(-1), { key: '2027-01', value: '5', tasks: 1 })
  assert.deepEqual(tasks, before)
})

test('all tasks participate beyond the 200-task prompt and 100-row detail limits, joining task-owned IDs by name', () => {
  const tasks = Array.from({ length: 250 }, (_, i) => task(String(i), i === 249 ? '1000' : '2'))
  const result = query(tasks)
  assert.equal(result.total, '1498'); assert.equal(result.matchedTasks, 250)
  assert.equal(result.details.length, 100); assert.equal(result.detailsTruncated, true)
  assert.deepEqual(buildTaskAttributeCatalog(tasks), [{ name: '搬迁服务器台数', type: 'number', unit: '台', tasks: 250, filled: 250 }])
})

test('exact decimal sums preserve large money, cents, eight decimal places, negatives and zero', () => {
  const money = (id: string, value: string) => task(id, value, '2026-01-31', { custom_fields: [field(`field-${id}`, { type: 'money', name: '支出金额', unit: '元' })] })
  assert.equal(query([money('a', '999999999999999999.99'), money('b', '0.02')], { attribute_name: '支出金额' }).total, '1000000000000000000.01')
  const result = query([task('a', '0.10000001'), task('b', '0.2'), task('c', '-0.3'), task('d', '0')])
  assert.equal(result.total, '0.00000001'); assert.equal(result.matchedTasks, 4)
  assert.equal(query([money('a', '-0.01'), money('b', '0.01')], { attribute_name: '支出金额' }).total, '0.00')
})

test('missing attributes are not attached automatically, blank values are not zero, and invalid values/dates are reported', () => {
  const result = query([task('a', '0'), task('b', ''), task('c', undefined), task('d', '12台'), task('e', '5', '2026-02-30'),
    task('f', '6', '2026-01-01', { end_date: null }), task('unattached', '100', '2026-01-01', { custom_fields: [] })])
  assert.equal(result.total, '0'); assert.equal(result.matchedTasks, 1)
  assert.equal(result.skipped.empty, 2); assert.equal(result.skipped.invalid, 1); assert.equal(result.skipped.missingDate, 2)
})

test('different types or units are never silently mixed, while explicit disambiguation works', () => {
  const tasks = [task('a', '12'), task('b', '3', '2026-01-31', { custom_fields: [field('field-b', { unit: '批' })] }),
    task('c', '4', '2026-01-31', { custom_fields: [field('field-c', { type: 'text', unit: undefined })] })]
  const result = queryTaskAttributes(tasks, { attribute_name: '搬迁服务器台数' })
  assert.equal(result.ok, false); if (!result.ok) { assert.equal(result.candidates?.length, 3); assert.match(result.error, /不能直接相加/) }
  assert.equal(query(tasks, { unit: '台' }).total, '12')
  assert.equal(query(tasks, { attribute_type: 'text', unit: '' }).total, '4')
  assert.match(query(tasks, { attribute_type: 'text', unit: '' }).warnings[0], /纯数字/)
})

test('summary, deleted, inherited inactive and archived values do not inflate default totals', () => {
  const tasks = [task('summary', '100'), task('child', '10', '2026-01-31', { parent_id: 'summary' }),
    task('inactive', '30', '2026-01-31', { inactive: true }), task('inactive-child', '20', '2026-01-31', { parent_id: 'inactive' }),
    task('deleted', '40', '2026-01-31', { is_deleted: true }), task('archived', '50', '2026-01-31', { custom_fields: [field('field-archived', { archived: true })] })]
  const result = query(tasks)
  assert.equal(result.total, '10'); assert.equal(result.skipped.summary, 2); assert.equal(result.skipped.inactive, 1); assert.equal(result.skipped.archived, 1)
  const inclusive = query(tasks, { include_summary: true, include_inactive: true, include_archived: true })
  assert.equal(inclusive.total, '210'); assert.match(inclusive.warnings[0], /重复统计/)
})

test('parent-only requests cannot include child values even when the model uses the legacy include_summary flag', () => {
  const tasks = [task('parent', '30'), task('a', '10', undefined, { parent_id: 'parent' }), task('b', '20', undefined, { parent_id: 'parent' }), task('independent', '5')]
  const input = { attribute_name: '搬迁服务器台数', operation: 'sum', group_by: 'none', include_summary: true }
  const [parent] = queryTaskAttributeReports(tasks, input, [], { text: '只汇总父任务的搬迁服务器台数，不计子任务，覆盖全部计划' })
  assert.equal(parent.ok, true)
  if (parent.ok) { assert.equal(parent.total, '30'); assert.equal(parent.matchedTasks, 1); assert.equal(parent.query.task_scope, 'summary'); assert.equal(parent.skipped.leaf, 3) }
  const [leaf] = queryTaskAttributeReports(tasks, input, [], { text: '只汇总子任务的搬迁服务器台数，不计父任务，覆盖全部计划' })
  assert.equal(leaf.ok, true)
  if (leaf.ok) { assert.equal(leaf.total, '35'); assert.equal(leaf.query.task_scope, 'leaf'); assert.match(attributeQueryMessage(leaf), /避免父子重复累计/) }
  const separate = queryTaskAttributeReports(tasks, input, [], { text: '父任务和子任务的搬迁服务器台数分别汇总，不要把父子相加' })
  assert.deepEqual(separate.map(report => report.ok && report.total), ['30', '35'])
  assert.ok(separate.every(report => report.ok && report.total !== '65'))
})

test('nested parents are reported per level and never combined with their descendants', () => {
  const tasks = [task('root', '30'), task('sub', '30', undefined, { parent_id: 'root' }), task('a', '10', undefined, { parent_id: 'sub' }), task('b', '20', undefined, { parent_id: 'sub' })]
  const before = structuredClone(tasks)
  const parents = queryTaskAttributeReports(tasks, { attribute_name: '搬迁服务器台数', task_scope: 'summary' })
  assert.deepEqual(parents.map(report => report.ok && report.total), ['30', '30'])
  assert.ok(parents[0].ok && parents[0].scope.includes('第1层父任务'))
  assert.ok(parents[1].ok && parents[1].scope.includes('第2层父任务'))
  assert.equal(query(tasks).total, '30')
  const separate = queryTaskAttributeReports(tasks, { attribute_name: '搬迁服务器台数', task_scope: 'separate' })
  assert.equal(separate.length, 3)
  assert.ok(separate.every(report => report.ok && report.total === '30'))
  assert.deepEqual(tasks, before)
  assert.equal(queryTaskAttributes(tasks, { attribute_name: '搬迁服务器台数', task_scope: 'invalid' }).ok, false)
})

test('duplicate model calls produce one result for each actual unit, type and hierarchy scope', () => {
  const tasks = [task('parent', '12'), task('child', '12', undefined, { parent_id: 'parent' })]
  const input = { attribute_name: '搬迁服务器台数', group_by: 'none' }
  const reports = [true, false].flatMap(include_summary => queryTaskAttributeReports(tasks, { ...input, include_summary }, [], { text: '父子分别统计搬迁服务器台数' }))
  assert.equal(reports.length, 4)
  const unique = deduplicateAttributeReports(reports)
  assert.equal(unique.length, 2)
  assert.deepEqual(unique.map(report => report.ok && report.query.task_scope), ['summary', 'leaf'])
})

test('numeric attribute names with empty values are not treated as quantities or announced as zero', () => {
  const result = query([task('a', undefined, undefined, { custom_fields: [field('field-a', { name: '6' })] })], { attribute_name: '6' })
  const answer = attributeQueryMessage(result)
  assert.match(answer, /尚未填写属性值，无法汇总/)
  assert.match(answer, /属性名称中的数字不会当作填报数量/)
  assert.doesNotMatch(answer, /合计0|合计6/)
  assert.match(attributeQueryMessage(query([task('a', '0')])), /合计0台/)
})

test('a populated parent cannot turn unreported children into a reported zero', () => {
  const result = query([task('parent', '193'), task('child', undefined, undefined, { parent_id: 'parent' })])
  assert.equal(result.matchedTasks, 0)
  assert.equal(result.skipped.empty, 1)
  const answer = attributeQueryMessage(result)
  assert.match(answer, /没有符合条件的已填记录，暂时无法汇总/)
  assert.doesNotMatch(answer, /合计0台|合计193台/)
})

test('partial reporting follows current task values, preserves explicit zeros and discloses blanks', () => {
  for (const [values, expected] of [[['13.25', '-1.25', '0'], '12'], [['21', '3.5', '0'], '24.5'], [['0', '0', '0'], '0']] as [string[], string][]) {
    const tasks = [task('parent', '999'), ...values.map((value, index) => task(String(index), value, undefined, { parent_id: 'parent' })),
      task('empty', '', undefined, { parent_id: 'parent' }), task('missing', undefined, undefined, { parent_id: 'parent' })]
    const before = structuredClone(tasks), result = query(tasks)
    assert.equal(result.total, expected); assert.equal(result.matchedTasks, 3); assert.equal(result.skipped.empty, 2)
    const answer = attributeQueryMessage(result)
    assert.ok(answer.includes(`合计${expected}台`)); assert.match(answer, /未填属性2项/)
    assert.deepEqual(tasks, before)
  }
})

test('zero filled-task count is valid even though an unreported numeric total cannot be claimed as zero', () => {
  const tasks = [task('a', undefined), task('b', '')]
  const result = query(tasks, { operation: 'count', group_by: 'none' })
  assert.equal(result.total, '0'); assert.equal(result.matchedTasks, 0)
  const answer = attributeQueryMessage(result)
  assert.match(answer, /合计0个任务/); assert.match(answer, /未填属性2项/)
  assert.doesNotMatch(answer, /合计0台|无法汇总/)
})

test('本月安装多少台服务器 selects a dedicated installation attribute without requiring it in task names', () => {
  const tasks = [task('a', '3', '2026-11-01'), task('b', '5', '2026-11-30'), task('old', '100', '2026-10-31'), task('next', '200', '2026-12-01')]
    .map(task => ({ ...task, name: `机房${task.id}`, custom_fields: [field(`field-${task.id}`, { name: '安装服务器台数' })] }))
  const [report] = queryTaskAttributeReports(tasks, { attribute_name: '安装服务器台数', operation: 'count', task_name: '安装服务器', from_date: '2026-01-01', to_date: '2026-12-31' }, [], { text: '本月安装多少台服务器', today: '2026-11-10' })
  assert.equal(isTaskAttributeQueryIntent('本月安装多少台服务器', buildTaskAttributeCatalog(tasks)), true)
  assert.equal(isTaskAttributeQueryIntent('本月安装多少 台服务器', []), true)
  assert.equal(report.ok, true)
  if (report.ok) {
    assert.equal(report.total, '8'); assert.equal(report.query.operation, 'sum'); assert.equal(report.matchedTasks, 2)
    assert.equal(report.query.from_date, '2026-11-01'); assert.equal(report.query.to_date, '2026-11-30')
    assert.equal(report.query.task_name, undefined); assert.deepEqual(report.query.task_keywords, ['安装', '服务器'])
    assert.deepEqual(report.details.map(row => row.value), ['3', '5'])
    assert.match(attributeQueryMessage(report), /安装服务器台数/)
  }
})

test('installation quantity queries filter generic attributes by both action and object in either word order', () => {
  const tasks = [task('a', '2', '2026-11-01', { name: '安装服务器999A' }), task('b', '5', '2026-11-30', { name: '服务器B安装' }),
    task('move', '100', '2026-11-15', { name: '搬迁服务器C' }), task('switch', '40', '2026-11-15', { name: '安装交换机D' }),
    task('outside', '200', '2026-10-31', { name: '安装服务器E' }), task('empty', undefined, '2026-11-15', { name: '安装服务器F' })]
    .map(task => ({ ...task, custom_fields: [field(`field-${task.id}`, { name: '设备台数' })] }))
  const before = structuredClone(tasks)
  for (const task_name of [undefined, '安装', '安装服务器', '服务器安装']) {
    const [report] = queryTaskAttributeReports(tasks, { attribute_name: '设备台数', operation: 'sum', task_name }, [], { text: '本月安装多少台服务器', today: '2026-11-10' })
    assert.equal(report.ok, true)
    if (report.ok) {
      assert.equal(report.total, '7'); assert.equal(report.matchedTasks, 2); assert.equal(report.skipped.empty, 1)
      assert.deepEqual(report.details.map(row => row.taskId), ['a', 'b'])
      assert.match(attributeQueryMessage(report), /「安装」、「服务器」/)
    }
  }
  assert.deepEqual(tasks, before)
})

test('installation filters inherit parent context without inheriting a conflicting leaf action or device type', () => {
  const tasks = [task('parent', '7', '2026-11-15', { name: '服务器安装' }),
    task('a', '2', '2026-11-15', { name: '设备上架', parent_id: 'parent' }), task('b', '5', '2026-11-15', { name: '系统部署', parent_id: 'parent' }),
    task('move', '100', '2026-11-15', { name: '搬迁服务器', parent_id: 'parent' }), task('switch', '40', '2026-11-15', { name: '安装交换机', parent_id: 'parent' })]
    .map(task => ({ ...task, custom_fields: [field(`field-${task.id}`, { name: '设备台数' })] }))
  const input = { attribute_name: '设备台数', operation: 'sum' }, context = { text: '本月安装多少台服务器', today: '2026-11-10' }
  const [report] = queryTaskAttributeReports(tasks, input, [], context)
  assert.equal(report.ok, true)
  if (report.ok) {
    assert.equal(report.total, '7'); assert.equal(report.skipped.summary, 1)
    assert.deepEqual(report.details.map(row => row.taskPath), ['服务器安装 / 设备上架', '服务器安装 / 系统部署'])
  }
  const updated = tasks.map(task => task.id === 'b' ? { ...task, custom_values: { 'field-b': '9' } } : task)
  const [changed] = queryTaskAttributeReports(updated, input, [], context)
  assert.ok(changed.ok && changed.total === '11')
})

test('task keyword filters validate input and retain explicit task-name selections', () => {
  const tasks = [task('a', '2', '2026-11-15', { name: '安装服务器' }), task('b', '5', '2026-11-15', { name: '服务器安装' })]
  for (const task_keywords of ['安装', [1], [''], Array(21).fill('安装')]) assert.equal(queryTaskAttributes(tasks, { attribute_name: '搬迁服务器台数', task_keywords }).ok, false)
  const [report] = queryTaskAttributeReports(tasks, { attribute_name: '搬迁服务器台数', task_name: '安装服务器' }, [], { text: '本月任务名称包含安装服务器的共有多少台', today: '2026-11-10' })
  assert.ok(report.ok && report.total === '2' && report.query.task_name === '安装服务器')
})

test('服务器 attributes on equipment racking tasks answer installation questions without changing their names or dates', () => {
  const tasks = [task('a', '2', '2026-11-15', { name: '设备上架' }), task('b', '3', '2026-11-15', { name: '系统部署' }),
    task('c', '5', '2026-11-15', { name: '服务器安装' }), task('remove', '80', '2026-11-15', { name: '设备下架' }),
    task('move', '90', '2026-11-15', { name: '服务器搬迁' })]
    .map(task => ({ ...task, custom_fields: [field(`field-${task.id}`, { name: '服务器' })] }))
  const before = structuredClone(tasks)
  const [report] = queryTaskAttributeReports(tasks, { attribute_name: '服务器', operation: 'sum' }, [], { text: '本月安装多少台服务器', today: '2026-11-10' })
  assert.ok(report.ok && report.total === '10' && report.matchedTasks === 3)
  assert.deepEqual(tasks, before)
})

test('an AI-guessed unit or type cannot bypass a real ambiguity without user selection', () => {
  const tasks = [task('a', '12'), task('b', '3', '2026-01-31', { custom_fields: [field('field-b', { unit: '批' })] })]
  const input = { attribute_name: '搬迁服务器台数', unit: '台', attribute_type: 'number', operation: 'sum' }
  assert.equal(queryTaskAttributes(tasks, input, [], { text: '每月汇总搬迁服务器台数' }).ok, false)
  const selected = queryTaskAttributes(tasks, input, [], { text: '只统计单位为台的搬迁服务器台数' })
  assert.equal(selected.ok, true); if (selected.ok) assert.equal(selected.total, '12')
  const followed = queryTaskAttributes(tasks, input, [], { text: '只看1月', previousQuery: { attribute_name: '搬迁服务器台数', unit: '台' } })
  assert.equal(followed.ok, true)
  const currencyTasks = [task('a', '10', '2026-01-01', { custom_fields: [field('field-a', { unit: '元' })] }), task('b', '20', '2026-01-01', { custom_fields: [field('field-b', { unit: '美元' })] })]
  assert.equal(queryTaskAttributes(currencyTasks, { ...input, unit: '元' }, [], { text: '只看美元的搬迁服务器台数' }).ok, false)
})

test('AI answers different units separately without asking the user to choose', () => {
  const tasks = [task('a', '12'), task('b', '3', '2026-01-31', { custom_fields: [field('field-b', { unit: '批' })] })]
  const reports = queryTaskAttributeReports(tasks, { attribute_name: '搬迁服务器台数', unit: '台', attribute_type: 'number' }, [], { text: '每月汇总搬迁服务器台数' })
  assert.equal(reports.length, 2)
  const answers = reports.map(result => attributeQueryMessage(result)).join('\n')
  assert.match(answers, /合计12台/); assert.match(answers, /合计3批/)
  assert.doesNotMatch(answers, /请选择|请指定|合计15/)
})

test('natural-language future ranges have concrete calendar boundaries without a range selector', () => {
  const today = '2026-11-08'
  for (const text of ['后3个月的搬迁数量', '未来三个月搬迁多少台', '接下来三个月的台数']) {
    assert.deepEqual(resolveAttributeDateRange(text, today), { from: '2026-12-01', to: '2027-02-28' })
  }
  assert.deepEqual(resolveAttributeDateRange('后3个月含本月', today), { from: '2026-11-01', to: '2027-01-31' })
  assert.deepEqual(resolveAttributeDateRange('从今天起未来3个月', today), { from: '2026-11-08', to: '2027-02-07' })
  assert.deepEqual(resolveAttributeDateRange('本月', today), { from: '2026-11-01', to: '2026-11-30' })
  assert.deepEqual(resolveAttributeDateRange('今年', today), { from: '2026-01-01', to: '2026-12-31' })
  assert.deepEqual(resolveAttributeDateRange('2027年1月至3月', today), { from: '2027-01-01', to: '2027-03-31' })
  assert.deepEqual(resolveAttributeDateRange('从11月至明年2月', today), { from: '2026-11-01', to: '2027-02-28' })
  assert.deepEqual(resolveAttributeDateRange('2028年2月', today), { from: '2028-02-01', to: '2028-02-29' })
  assert.deepEqual(resolveAttributeDateRange('2026-11-10至2027-01-15', today), { from: '2026-11-10', to: '2027-01-15' })
  assert.equal(isTaskAttributeQueryIntent('那后3个月呢？', [], true), true)
})

test('text answers use all monthly totals and enforce the requested future range even if the model guesses dates', () => {
  const tasks = [task('a', '10', '2026-12-01'), task('b', '20', '2027-01-31'), task('c', '30', '2027-02-28'), task('outside', '500', '2027-03-01')]
  const [result] = queryTaskAttributeReports(tasks, { attribute_name: '搬迁服务器台数', operation: 'sum', group_by: 'none', date_field: 'start_date', from_date: '2026-11-01', to_date: '2027-01-31' }, [], { text: '后3个月搬迁多少台', today: '2026-11-08' })
  assert.equal(result.ok, true)
  if (result.ok) { assert.equal(result.total, '60'); assert.equal(result.matchedTasks, 3); assert.equal(result.query.date_field, 'end_date'); assert.equal(result.query.group_by, 'month') }
  const answer = attributeQueryMessage(result, true)
  for (const value of ['2026-12-01至2027-02-28', '2026年12月：10台', '2027年1月：20台', '2027年2月：30台', '合计60台', '包含尚未保存的修改']) assert.ok(answer.includes(value), value)
  assert.doesNotMatch(answer, /请选择|确认|\|/)
})

test('date ranges are inclusive and use natural months; zero-record months are explicit', () => {
  const result = query([task('a', '2', '2026-01-01'), task('b', '3', '2026-01-31T23:59:00'), task('c', '100', '2026-02-01')],
    { from_date: '2026-01-01', to_date: '2026-01-31' })
  assert.equal(result.total, '5'); assert.equal(result.matchedTasks, 2)
  const empty = query([task('a', '10', '2026-03-31')], { from_date: '2026-01-01', to_date: '2026-02-28' })
  assert.equal(empty.total, '0'); assert.equal(empty.matchedTasks, 0)
  assert.deepEqual(empty.groups, [{ key: '2026-01', value: '0', tasks: 0 }, { key: '2026-02', value: '0', tasks: 0 }])
})

test('start dates and user-supplied actual date attributes are used only when explicitly selected', () => {
  const tasks = [task('a', '12', '2026-05-01', {
    custom_fields: [field('field-a'), { id: 'actual', name: '实际搬迁日期', type: 'date' }],
    custom_values: { 'field-a': '12', actual: '2026-03-01' },
  })]
  assert.equal(query(tasks).groups[0].key, '2026-05')
  assert.equal(query(tasks, { date_field: 'start_date' }).groups[0].key, '2025-12')
  assert.equal(query(tasks, { date_field: 'custom_date', date_attribute: '实际搬迁日期' }).groups[0].key, '2026-03')
  assert.equal(queryTaskAttributes(tasks, { attribute_name: '搬迁服务器台数', date_field: 'custom_date', date_attribute: '不存在日期' }).ok, false)
})

test('list and count query text/select attributes without pretending they are numeric measures', () => {
  const tasks = ['北京', '上海', '北京'].map((value, index) => task(String(index), value, '2026-01-01', {
    custom_fields: [field(`field-${index}`, { name: '机房', type: 'select', unit: undefined, options: ['北京', '上海'] })],
  }))
  assert.equal(query(tasks, { attribute_name: '机房', operation: 'count', value_equals: '北京' }).total, '2')
  const result = query(tasks, { attribute_name: '机房', operation: 'list', group_by: 'none', task_name: '搬迁-1' })
  assert.equal(result.total, null); assert.deepEqual(result.details.map(row => row.value), ['上海'])
  assert.equal(queryTaskAttributes(tasks, { attribute_name: '机房', operation: 'sum' }).ok, false)
})

test('legacy project definitions apply only to values actually attached to that task', () => {
  const legacy = [field('legacy')]
  const tasks = [task('a', undefined, '2026-01-01', { custom_fields: undefined, custom_values: { legacy: '10' } }),
    task('b', undefined, '2026-01-01', { custom_fields: undefined }), task('c', undefined, '2026-01-01', { custom_fields: [], custom_values: { legacy: '100' } })]
  assert.equal(query(tasks, {}, legacy).total, '10')
})

test('invalid queries fail with actionable errors rather than zero totals', () => {
  for (const input of [null, [], { attribute_name: 10 }, { attribute_name: '未知属性' },
    { attribute_name: '搬迁服务器台数', operation: 'average' }, { attribute_name: '搬迁服务器台数', from_date: '2026-02-30' },
    { attribute_name: '搬迁服务器台数', from_date: '2026-02-01', to_date: '2026-01-31' },
    { attribute_name: '搬迁服务器台数', include_summary: 'false' }]) assert.equal(queryTaskAttributes([task('a', '12')], input).ok, false)
  assert.equal(queryTaskAttributes([task('a', '12')], { attribute_name: '搬迁服务器台数', unit: null, date_field: null }).ok, true)
})

test('attribute intents and follow-ups avoid progress-summary rules without changing editing intents', () => {
  const catalog = buildTaskAttributeCatalog([task('a', '10')])
  for (const text of ['统计每月搬迁的台数', '本月搬迁服务器台数合计多少？', '查询搬迁服务器台数', '每月搬迁了几台？']) assert.equal(isTaskAttributeQueryIntent(text, catalog), true, text)
  assert.equal(isTaskAttributeQueryIntent('那今年按开始日期统计呢？', catalog, true), true)
  for (const text of ['总结本月进展', '生成周报', '把任务改为自动', '创建搬迁服务器任务']) assert.equal(isTaskAttributeQueryIntent(text, catalog, true), false, text)
})

test('AI prompt exposes full-project attribute names and requires the read-only tool for exact totals', () => {
  const tasks = Array.from({ length: 201 }, (_, i) => task(String(i), '1'))
  tasks[200].custom_fields = [field('field-200', { name: '第201项专属数量' })]
  const prompt = buildSystemPrompt('P', tasks, [], undefined, null, null, undefined, false, [], '2026-11-08')
  assert.match(prompt, /第201项专属数量/); assert.match(prompt, /不能用前200条任务摘要估算/)
  assert.match(prompt, /跨月任务整笔归到结束月份/); assert.match(prompt, /Today: 2026-11-08/)
  const tool = AI_TOOLS.find(tool => tool.function.name === 'query_task_attributes')
  assert.ok(tool); assert.match(tool.function.description, /sum是属性数值之和/)
})
