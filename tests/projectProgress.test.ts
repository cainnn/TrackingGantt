import test from 'node:test'
import assert from 'node:assert/strict'
import { computeProjectProgressPercent, computeSummaryProgressMap, computeTimeBasedPercent } from '../lib/projectProgress'
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

test('summary progress decreases when child tasks move later against the same status date', () => {
  const statusDate = '2026-06-05T00:00:00'
  const original = [
    task({ id: 'summary', duration: 10 * 1440, start_date: '2026-06-01T00:00:00', end_date: '2026-06-11T00:00:00' }),
    task({ id: 'leaf-1', parent_id: 'summary', duration: 10 * 1440, start_date: '2026-06-01T00:00:00', end_date: '2026-06-11T00:00:00' }),
  ]
  const movedLater = [
    task({ id: 'summary', duration: 10 * 1440, start_date: '2026-06-03T00:00:00', end_date: '2026-06-13T00:00:00' }),
    task({ id: 'leaf-1', parent_id: 'summary', duration: 10 * 1440, start_date: '2026-06-03T00:00:00', end_date: '2026-06-13T00:00:00' }),
  ]

  const originalPct = computeSummaryProgressMap(original, statusDate).get('summary')
  const movedPct = computeSummaryProgressMap(movedLater, statusDate).get('summary')

  assert.equal(originalPct, 40)
  assert.equal(movedPct, 20)
  assert.ok(movedPct < originalPct)
})

test('root and child summary progress decrease when task 14 is dragged later', () => {
  const statusDate = '2026-05-29T00:00:00'
  const root = task({
    id: 'cdn',
    name: 'CDN七期集成项目',
    start_date: '2026-03-10T00:00:00',
    end_date: '2026-08-31T00:00:00',
    duration: 174 * 1440,
  })
  const childSummary = task({
    id: 'self-platform',
    parent_id: 'cdn',
    name: '咪咕自研平面集成进度',
    start_date: '2026-03-10T00:00:00',
    end_date: '2026-08-31T00:00:00',
    duration: 174 * 1440,
  })
  const completed = [
    task({ id: 'done-1', parent_id: 'self-platform', start_date: '2026-03-10T00:00:00', end_date: '2026-03-16T00:00:00', duration: 6 * 1440 }),
    task({ id: 'done-2', parent_id: 'self-platform', start_date: '2026-03-16T00:00:00', end_date: '2026-03-23T00:00:00', duration: 7 * 1440 }),
    task({ id: 'done-3', parent_id: 'self-platform', start_date: '2026-03-23T00:00:00', end_date: '2026-03-29T00:00:00', duration: 6 * 1440 }),
    task({ id: 'done-4', parent_id: 'self-platform', start_date: '2026-04-21T00:00:00', end_date: '2026-05-28T00:00:00', duration: 37 * 1440 }),
  ]
  const task14 = task({
    id: 'task-14',
    task_code: '14',
    parent_id: 'self-platform',
    name: '直播业务策略开通',
    start_date: '2026-05-26T00:00:00',
    end_date: '2026-07-15T00:00:00',
    duration: 50 * 1440,
  })
  const laterTask14 = {
    ...task14,
    start_date: '2026-05-29T00:00:00',
    end_date: '2026-07-18T00:00:00',
  }

  const before = computeSummaryProgressMap([root, childSummary, ...completed, task14], statusDate)
  const after = computeSummaryProgressMap([root, childSummary, ...completed, laterTask14], statusDate)

  assert.ok((after.get('self-platform') ?? 0) < (before.get('self-platform') ?? 0))
  assert.ok((after.get('cdn') ?? 0) < (before.get('cdn') ?? 0))
})
