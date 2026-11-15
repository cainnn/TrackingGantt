import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTaskCopies } from '../lib/clientTaskCopy'
import { buildSaveDiff } from '../lib/clientSave'
import { runFullCascade } from '../lib/clientScheduling'
import type { Dependency, Task } from '../types'
import tasksReducer, { setTasks, copyTasks } from '../store/slices/tasksSlice'

function task(id: string, order: number, parentId: string | null = null, extra: Partial<Task> = {}): Task {
  return {
    id, project_id: 'project-1', task_code: id, name: `任务${id}`, parent_id: parentId,
    assignee: '张三', start_date: '2026-11-02T00:00:00', end_date: '2026-11-03T00:00:00',
    duration: 1440, duration_unit: 'minute', percent_done: 50, is_milestone: false,
    note: '保留备注', order_index: order, is_deleted: false, deleted_at: null,
    baseline_end_date: '2026-11-02T00:00:00',
    created_at: '2026-11-01T00:00:00', updated_at: '2026-11-01T00:00:00',
    ...extra,
  }
}

function apply(tasks: Task[], result: ReturnType<typeof buildTaskCopies>): Task[] {
  const updates = new Map(result.tasksToUpdate.map(t => [t.id, t]))
  return [...tasks.map(t => updates.get(t.id) ?? t), ...result.tasksToAdd]
}

function siblingNames(tasks: Task[], parentId: string | null = null): string[] {
  return tasks.filter(t => t.parent_id === parentId && !t.is_deleted)
    .sort((a, b) => a.order_index - b.order_index).map(t => t.name)
}

for (const position of ['before', 'after'] as const) {
  test(`copies multiple tasks ${position} a target in display order and saves their new positions`, () => {
    const tasks = [task('3', 30), task('1', 10), task('4', 40), task('2', 20)]
    const snapshot = structuredClone(tasks)
    const result = buildTaskCopies(tasks, [], ['4', '1'], '3', position)
    const next = apply(tasks, result)
    const expected = position === 'before'
      ? ['任务1', '任务2', '任务1 (副本)', '任务4 (副本)', '任务3', '任务4']
      : ['任务1', '任务2', '任务3', '任务1 (副本)', '任务4 (副本)', '任务4']

    assert.deepEqual(siblingNames(next), expected)
    assert.deepEqual(tasks, snapshot)
    assert.deepEqual(result.tasksToAdd.map(t => t.task_code), ['5', '6'])
    assert.equal(new Set(next.map(t => t.id)).size, next.length)
    for (const copy of result.tasksToAdd) {
      assert.equal(copy.note, '保留备注')
      assert.equal(copy.percent_done, 50)
      assert.equal(copy.duration, 1440)
      assert.equal(copy.baseline_end_date, null)
    }
    const diff = buildSaveDiff(tasks, [], next, [])
    assert.equal(diff.tasksToAdd.length, 2)
    assert.equal(diff.tasksToUpdate.length, result.tasksToUpdate.length)
    assert.deepEqual(siblingNames([...diff.tasksToUpdate, ...diff.tasksToAdd]), expected)
  })
}

test('copies a summary subtree once and remaps only its internal dependencies', () => {
  const tasks = [task('4', 2, '1'), task('2', 0, '1'), task('1', 0), task('3', 0, '2'), task('5', 1)]
  const deps: Dependency[] = [
    { id: 'internal', project_id: 'project-1', from_task_id: '3', to_task_id: '4', type: 3, lag: 30, active: false },
    { id: 'external', project_id: 'project-1', from_task_id: '4', to_task_id: '5', type: 2, lag: 0 },
  ]
  const result = buildTaskCopies(tasks, deps, ['3', '1', '2'], '5', 'before')
  const copies = new Map(result.tasksToAdd.map(t => [t.name, t]))
  const parent = copies.get('任务1 (副本)')!
  const child = copies.get('任务2 (副本)')!
  const grandchild = copies.get('任务3 (副本)')!
  const sibling = copies.get('任务4 (副本)')!

  assert.deepEqual([...copies.keys()], ['任务1 (副本)', '任务2 (副本)', '任务3 (副本)', '任务4 (副本)'])
  assert.equal(parent.parent_id, null)
  assert.equal(child.parent_id, parent.id)
  assert.equal(grandchild.parent_id, child.id)
  assert.equal(sibling.parent_id, parent.id)
  assert.equal(result.dependenciesToAdd.length, 1)
  assert.deepEqual(result.dependenciesToAdd[0], {
    ...deps[0], id: result.dependenciesToAdd[0].id, from_task_id: grandchild.id, to_task_id: sibling.id,
  })
  assert.notEqual(result.dependenciesToAdd[0].id, deps[0].id)
  assert.deepEqual(siblingNames(apply(tasks, result)), ['任务1', '任务1 (副本)', '任务5'])
})

test('copies selected children to the target sibling level and updates destination summary dates', () => {
  const tasks = [
    task('1', 0), task('2', 0, '1', { end_date: '2026-11-05T00:00:00', duration: 4320 }),
    task('3', 1), task('4', 0, '3'),
  ]
  const result = buildTaskCopies(tasks, [], ['2'], '4', 'after')
  const copy = result.tasksToAdd[0]
  const next = apply(tasks, result)
  assert.equal(copy.parent_id, '3')
  assert.deepEqual(siblingNames(next, '3'), ['任务4', '任务2 (副本)'])
  const cascaded = runFullCascade(next, [], { isMinute: false })
  assert.equal(cascaded.find(t => t.id === '3')?.end_date, '2026-11-05T00:00:00')
  assert.equal(cascaded.find(t => t.id === '3')?.duration, 4320)
})

test('copying a task next to itself or inside its own subtree keeps parent references acyclic', () => {
  const tasks = [task('1', 0), task('2', 0, '1')]
  const selfCopy = buildTaskCopies(tasks, [], ['2'], '2', 'before')
  assert.deepEqual(siblingNames(apply(tasks, selfCopy), '1'), ['任务2 (副本)', '任务2'])

  const result = buildTaskCopies(tasks, [], ['1'], '2', 'after')
  const parentCopy = result.tasksToAdd[0]
  const childCopy = result.tasksToAdd[1]
  assert.equal(parentCopy.parent_id, '1')
  assert.equal(childCopy.parent_id, parentCopy.id)
  assert.deepEqual(siblingNames(apply(tasks, result), '1'), ['任务2', '任务1 (副本)'])
})

test('copies after a summary as its sibling and skips deleted tasks while reserving their codes', () => {
  const tasks = [task('1', 0), task('2', 0, '1'), task('3', 1), task('99', 2, null, { is_deleted: true })]
  const result = buildTaskCopies(tasks, [], ['3', '99'], '1', 'after')
  assert.equal(result.tasksToAdd.length, 1)
  assert.equal(result.tasksToAdd[0].parent_id, null)
  assert.equal(result.tasksToAdd[0].task_code, '100')
  assert.deepEqual(siblingNames(apply(tasks, result)), ['任务1', '任务3 (副本)', '任务3'])

  const second = buildTaskCopies(apply(tasks, result), [], ['3'], '1', 'after')
  assert.equal(second.tasksToAdd[0].task_code, '101')
  assert.notEqual(second.tasksToAdd[0].id, result.tasksToAdd[0].id)
})

test('empty or stale selection and missing targets do not create copies or reorder tasks', () => {
  const tasks = [task('1', 7)]
  for (const [selected, target] of [[[], '1'], [['missing'], '1'], [['1'], 'missing']] as [string[], string][]) {
    assert.deepEqual(buildTaskCopies(tasks, [], selected, target, 'before'), {
      tasksToAdd: [], tasksToUpdate: [], dependenciesToAdd: [],
    })
  }
  assert.equal(tasks[0].order_index, 7)
})

const link = (from: string, to: string, type = 2, lag = 0, active = true): Dependency => ({
  id: `${from}-${to}`, project_id: 'project-1', from_task_id: from, to_task_id: to, type, lag, active,
})

test('copying a task keeps its external predecessors without attaching the original successors to the copy', () => {
  const tasks = [task('1', 0), task('2', 1), task('3', 2)]
  const deps = [link('1', '2', 3, -45, false), link('2', '3')]
  const original = structuredClone({ tasks, deps })
  const result = buildTaskCopies(tasks, deps, ['2'], '3', 'after')
  const copy = result.tasksToAdd[0]
  assert.deepEqual(result.dependenciesToAdd.map(d => [d.from_task_id, d.to_task_id, d.type, d.lag, d.active]), [['1', copy.id, 3, -45, false]])
  assert.deepEqual({ tasks, deps }, original)
  const diff = buildSaveDiff(tasks, deps, apply(tasks, result), [...deps, ...result.dependenciesToAdd])
  assert.equal(diff.depsToAdd.length, 1)
  assert.deepEqual(diff.depsToDelete, [])
  assert.deepEqual(diff.depsToUpdate, [])
})

test('copying a chain maps internal links to copies and retains incoming links from unselected tasks', () => {
  const tasks = ['1', '2', '3', '4'].map((id, i) => task(id, i))
  const deps = [link('1', '2', 0, 15), link('2', '3', 2, 60), link('3', '4')]
  const result = buildTaskCopies(tasks, deps, ['3', '2'], '4', 'before')
  const [b, c] = result.tasksToAdd
  assert.deepEqual(result.dependenciesToAdd.map(d => [d.from_task_id, d.to_task_id, d.type, d.lag]), [['1', b.id, 0, 15], [b.id, c.id, 2, 60]])
  assert.ok(!result.dependenciesToAdd.some(d => d.to_task_id === '4'))
})

test('clipboard paste retains captured incoming relations after the original task has been removed', () => {
  const tasks = [task('1', 0), task('2', 1), task('3', 2)]
  const deps = [link('1', '2'), link('2', '3')]
  const seeded = tasksReducer(undefined, setTasks({ tasks, dependencies: deps }))
  const clipboard = tasksReducer(seeded, copyTasks(['2']))
  assert.equal(clipboard.clipboardDeps.length, 2)
  const result = buildTaskCopies(tasks.filter(t => t.id !== '2'), [], ['2'], '3', 'after', {
    tasks: clipboard.clipboard, dependencies: clipboard.clipboardDeps,
  })
  assert.equal(result.dependenciesToAdd.length, 1)
  assert.equal(result.dependenciesToAdd[0].from_task_id, '1')
  assert.equal(result.dependenciesToAdd[0].to_task_id, result.tasksToAdd[0].id)
})

test('missing external tasks and summary endpoints are reported while valid copied relations remain', () => {
  const tasks = [task('1', 0), task('2', 1), task('3', 2), task('child', 0, '1')]
  const deps = [link('1', '2'), link('missing', '2'), link('3', '2')]
  const result = buildTaskCopies(tasks, deps, ['2'], '3', 'after')
  assert.equal(result.dependenciesToAdd.length, 1)
  assert.equal(result.dependenciesToAdd[0].from_task_id, '3')
  assert.equal(result.skippedDependencies?.length, 2)
  assert.ok(result.skippedDependencies?.some(w => w.reason.includes('摘要任务')))
  assert.ok(result.skippedDependencies?.some(w => w.reason.includes('不存在')))
})

test('copy policies can preserve both boundary directions or only internal links without creating cycles', () => {
  const tasks = [task('a', 0), task('x', 1), task('y', 2)]
  const snapshot = { tasks: [tasks[0]], dependencies: [link('x', 'a'), link('a', 'y')] }
  const both = buildTaskCopies(tasks, [], ['a'], 'y', 'after', snapshot, { externalDependencies: 'all' })
  assert.deepEqual(both.dependenciesToAdd.map(d => [d.from_task_id, d.to_task_id]), [['x', both.tasksToAdd[0].id], [both.tasksToAdd[0].id, 'y']])
  const none = buildTaskCopies(tasks, [], ['a'], 'y', 'after', snapshot, { externalDependencies: 'none' })
  assert.deepEqual(none.dependenciesToAdd, [])
  const cyclic = buildTaskCopies(tasks, [link('y', 'x')], ['a'], 'y', 'after', snapshot, { externalDependencies: 'all' })
  assert.equal(cyclic.dependenciesToAdd.length, 1)
  assert.equal(cyclic.skippedDependencies?.length, 1)
  assert.match(cyclic.skippedDependencies![0].reason, /循环/)
})

test('every copied incoming relation retains its event type, signed lag, active flag and manual task mode', () => {
  for (const type of [0, 1, 2, 3]) for (const active of [true, false]) {
    const tasks = [task('1', 0), task('2', 1, null, { auto_schedule: false })]
    const result = buildTaskCopies(tasks, [link('1', '2', type, -30, active)], ['2'], '2', 'after')
    assert.equal(result.tasksToAdd[0].auto_schedule, false)
    assert.equal(result.dependenciesToAdd[0].type, type)
    assert.equal(result.dependenciesToAdd[0].lag, -30)
    assert.equal(result.dependenciesToAdd[0].active, active)
  }
})
