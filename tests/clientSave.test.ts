import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSaveDiff } from '../lib/clientSave'
import type { Dependency, Task } from '../types'

function task(partial: Partial<Task> & Pick<Task, 'id'>): Task {
  const base: Task = {
    id: partial.id,
    project_id: 'project-1',
    parent_id: null,
    task_code: partial.task_code ?? partial.id,
    name: partial.name ?? partial.id,
    assignee: null,
    start_date: '2026-06-01T00:00:00',
    end_date: '2026-06-02T00:00:00',
    duration: 1440,
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

const deps: Dependency[] = []

test('renumbers added tasks when client task codes collide with existing tasks or each other', () => {
  const baseline = [
    task({ id: 'existing-1', task_code: '1' }),
    task({ id: 'existing-2', task_code: '2' }),
    task({ id: 'existing-3', task_code: '3' }),
  ]
  const current = [
    ...baseline,
    task({ id: 'new-1', task_code: '3' }),
    task({ id: 'new-2', task_code: '3' }),
    task({ id: 'new-3', task_code: '4' }),
  ]

  const diff = buildSaveDiff(baseline, deps, current, deps)

  assert.deepEqual(diff.tasksToAdd.map(t => t.task_code), ['4', '5', '6'])
})
