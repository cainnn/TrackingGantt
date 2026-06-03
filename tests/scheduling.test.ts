import test from 'node:test'
import assert from 'node:assert/strict'
import { wouldCreateCycle } from '../lib/scheduling'
import { collapseDeletedTaskSuccessors, rollupSummaryTasks } from '../lib/clientScheduling'
import type { Dependency, Task } from '../types'

function task(partial: Partial<Task> & Pick<Task, 'id'>): Task {
  const base: Task = {
    id: partial.id,
    project_id: 'project-1',
    parent_id: null,
    task_code: partial.task_code ?? partial.id,
    name: partial.name ?? partial.id,
    assignee: null,
    start_date: partial.start_date ?? '2026-06-01T00:00:00',
    end_date: partial.end_date ?? '2026-06-02T00:00:00',
    duration: partial.duration ?? 1440,
    duration_unit: 'minute',
    percent_done: 0,
    is_milestone: false,
    note: null,
    order_index: 0,
    is_deleted: false,
    deleted_at: null,
    created_at: '2026-06-01T00:00:00',
    updated_at: '2026-06-01T00:00:00',
  }
  return { ...base, ...partial, id: partial.id }
}

function dep(partial: Partial<Dependency> & Pick<Dependency, 'from_task_id' | 'to_task_id'>): Dependency {
  return {
    id: `${partial.from_task_id}-${partial.to_task_id}`,
    project_id: 'project-1',
    from_task_id: partial.from_task_id,
    to_task_id: partial.to_task_id,
    type: partial.type ?? 2,
    lag: partial.lag ?? 0,
    active: partial.active ?? true,
  }
}

test('detects direct self dependency as a cycle', () => {
  assert.equal(wouldCreateCycle('task-1', 'task-1', []), true)
})

test('detects transitive dependency cycles', () => {
  const deps = [
    { from_task_id: 'task-2', to_task_id: 'task-3' },
    { from_task_id: 'task-3', to_task_id: 'task-4' },
  ]

  assert.equal(wouldCreateCycle('task-4', 'task-2', deps), true)
  assert.equal(wouldCreateCycle('task-1', 'task-2', deps), false)
})

test('collapses deleted task successors back to status date and cascades downstream', () => {
  const tasks = [
    task({ id: 'summary', start_date: '2026-06-10T00:00:00', end_date: '2026-06-14T00:00:00', duration: 4 * 1440 }),
    task({ id: 'deleted', start_date: '2026-06-01T00:00:00', end_date: '2026-06-03T00:00:00', duration: 2880 }),
    task({ id: 'successor', parent_id: 'summary', start_date: '2026-06-10T00:00:00', end_date: '2026-06-12T00:00:00', duration: 2880 }),
    task({ id: 'downstream', parent_id: 'summary', start_date: '2026-06-13T00:00:00', end_date: '2026-06-14T00:00:00', duration: 1440 }),
  ]
  const deps = [
    dep({ from_task_id: 'deleted', to_task_id: 'successor' }),
    dep({ from_task_id: 'successor', to_task_id: 'downstream' }),
  ]
  const remainingTasks = tasks.filter(t => t.id !== 'deleted')
  const remainingDeps = deps.filter(d => d.from_task_id !== 'deleted' && d.to_task_id !== 'deleted')

  const updates = collapseDeletedTaskSuccessors(remainingTasks, deps, remainingDeps, ['deleted'], '2026-06-05T00:00:00')
  const byId = new Map(updates.map(t => [t.id, t]))

  assert.equal(byId.get('successor')?.start_date, '2026-06-05T00:00:00')
  assert.equal(byId.get('successor')?.end_date, '2026-06-07T00:00:00')
  assert.equal(byId.get('successor')?.percent_done, 0)
  assert.equal(byId.get('downstream')?.start_date, '2026-06-07T00:00:00')
  assert.equal(byId.get('downstream')?.end_date, '2026-06-08T00:00:00')
  assert.equal(byId.get('downstream')?.percent_done, 0)
  assert.equal(byId.get('summary')?.start_date, '2026-06-05T00:00:00')
  assert.equal(byId.get('summary')?.end_date, '2026-06-08T00:00:00')
  assert.equal(byId.get('summary')?.duration, 3 * 1440)
})

test('does not collapse deleted task successors that already started before status date', () => {
  const tasks = [
    task({ id: 'deleted', start_date: '2026-06-01T00:00:00', end_date: '2026-06-03T00:00:00', duration: 2880 }),
    task({ id: 'successor', start_date: '2026-06-04T00:00:00', end_date: '2026-06-06T00:00:00', duration: 2880 }),
  ]
  const deps = [dep({ from_task_id: 'deleted', to_task_id: 'successor' })]
  const remainingTasks = tasks.filter(t => t.id !== 'deleted')
  const remainingDeps: Dependency[] = []

  const updates = collapseDeletedTaskSuccessors(remainingTasks, deps, remainingDeps, ['deleted'], '2026-06-05T00:00:00')

  assert.equal(updates.length, 0)
})

test('rolls up summary duration on every child duration preview change', () => {
  const baseTasks = [
    task({ id: 'summary', start_date: '2026-06-01T00:00:00', end_date: '2026-06-03T00:00:00', duration: 2 * 1440 }),
    task({ id: 'child', parent_id: 'summary', start_date: '2026-06-01T00:00:00', end_date: '2026-06-03T00:00:00', duration: 2 * 1440 }),
  ]
  const firstPreview = baseTasks.map(t => t.id === 'child'
    ? { ...t, end_date: '2026-06-04T00:00:00', duration: 3 * 1440 }
    : t
  )
  const secondPreview = baseTasks.map(t => t.id === 'child'
    ? { ...t, end_date: '2026-06-06T00:00:00', duration: 5 * 1440 }
    : t
  )

  const firstSummary = rollupSummaryTasks(firstPreview).find(t => t.id === 'summary')
  const secondSummary = rollupSummaryTasks(secondPreview).find(t => t.id === 'summary')

  assert.equal(firstSummary?.end_date, '2026-06-04T00:00:00')
  assert.equal(firstSummary?.duration, 3 * 1440)
  assert.equal(secondSummary?.end_date, '2026-06-06T00:00:00')
  assert.equal(secondSummary?.duration, 5 * 1440)
})
