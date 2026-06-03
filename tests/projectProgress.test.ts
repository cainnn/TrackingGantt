import test from 'node:test'
import assert from 'node:assert/strict'
import { computeProjectProgressPercent, computeTimeBasedPercent } from '../lib/projectProgress'
import type { Task } from '../types'

function task(partial: Partial<Task> & Pick<Task, 'id'>): Task {
  const base: Task = {
    id: partial.id,
    project_id: 'project-1',
    parent_id: null,
    task_code: partial.task_code ?? partial.id,
    name: partial.name ?? partial.id,
    assignee: null,
    start_date: partial.start_date ?? '2026-06-01T00:00:00',
    end_date: partial.end_date ?? '2026-06-03T00:00:00',
    duration: partial.duration ?? 2880,
    duration_unit: 'minute',
    percent_done: partial.percent_done ?? 0,
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

test('computes time based task percent from status date', () => {
  assert.equal(computeTimeBasedPercent(task({ id: 'task-1' }), '2026-06-02T00:00:00'), 50)
})

test('computes project progress from leaf tasks only', () => {
  const tasks = [
    task({ id: 'summary', duration: 10000 }),
    task({ id: 'leaf-1', parent_id: 'summary', duration: 60, percent_done: 100 }),
    task({ id: 'leaf-2', parent_id: 'summary', duration: 60, percent_done: 0 }),
  ]

  assert.equal(computeProjectProgressPercent(tasks), 50)
})
