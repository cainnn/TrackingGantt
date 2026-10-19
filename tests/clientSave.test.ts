import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSaveDiff, mergeSavedRecords, recoverSaveRecords } from '../lib/clientSave'
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

test('repairs a fractional legacy duration from task dates before updating', () => {
  const baseline = [task({ id: 'historical', duration: 1440, percent_done: 100 })]
  const current = [task({
    id: 'historical',
    start_date: '2026-06-01T00:00:00',
    end_date: '2026-06-08T16:00:00',
    duration: 7.666666666666667,
    percent_done: 100,
  })]

  const diff = buildSaveDiff(baseline, deps, current, deps)

  assert.equal(diff.tasksToUpdate.length, 1)
  assert.equal(diff.tasksToUpdate[0].duration, 11_040)
  assert.equal(Number.isInteger(diff.tasksToUpdate[0].duration), true)
})

test('server schedule wins when the user did not edit that task while saving', () => {
  const submitted = [task({ id: 'C', end_date: '2026-06-25T00:00:00' })]
  const saved = [task({ id: 'C', end_date: '2026-06-26T00:00:00' })]

  const merged = mergeSavedRecords(saved, submitted, submitted)

  assert.equal(merged[0].end_date, '2026-06-26T00:00:00')
  assert.equal(buildSaveDiff(saved, deps, merged, deps).tasksToUpdate.length, 0)
})

test('a newer local edit made during save is retained and remains dirty against server baseline', () => {
  const submitted = [task({ id: 'C', end_date: '2026-06-25T00:00:00' })]
  const saved = [task({ id: 'C', end_date: '2026-06-26T00:00:00' })]
  const current = [task({ id: 'C', end_date: '2026-06-27T00:00:00' })]

  const merged = mergeSavedRecords(saved, submitted, current)
  const diff = buildSaveDiff(saved, deps, merged, deps)

  assert.equal(merged[0].end_date, '2026-06-27T00:00:00')
  assert.equal(diff.tasksToUpdate.length, 1)
  assert.equal(diff.tasksToUpdate[0].end_date, '2026-06-27T00:00:00')
})

test('server schedule and newer local edits to another field are merged field by field', () => {
  const submitted = [task({ id: 'C', name: 'Before', end_date: '2026-06-25T00:00:00' })]
  const saved = [task({ id: 'C', name: 'Before', end_date: '2026-06-26T00:00:00' })]
  const current = [task({ id: 'C', name: 'Renamed while saving', end_date: '2026-06-25T00:00:00' })]

  const merged = mergeSavedRecords(saved, submitted, current)

  assert.equal(merged[0].name, 'Renamed while saving')
  assert.equal(merged[0].end_date, '2026-06-26T00:00:00')
})

test('local additions and deletions made during save survive reconciliation', () => {
  const submitted = [task({ id: 'existing' })]
  const saved = [task({ id: 'existing' })]
  const current = [task({ id: 'new-local' })]

  const merged = mergeSavedRecords(saved, submitted, current)

  assert.deepEqual(merged.map(t => t.id), ['new-local'])
})

test('retry updates a committed create instead of creating it again, preserving edits made after failure', () => {
  const committed = task({ id: 'created', name: 'First attempt' })
  const current = [{ ...committed, name: 'Edited after failure' }]
  const recovered = recoverSaveRecords([], [committed], ['created'])
  const diff = buildSaveDiff(recovered, deps, current, deps)
  assert.equal(diff.tasksToAdd.length, 0)
  assert.equal(diff.tasksToUpdate[0].name, 'Edited after failure')
})

test('retry removes a committed local addition deleted after the failed attempt without deleting remote additions', () => {
  const committed = task({ id: 'created' })
  const remote = task({ id: 'another-session' })
  const recovered = recoverSaveRecords([], [committed, remote], ['created'])
  assert.deepEqual(buildSaveDiff(recovered, deps, [], deps).tasksToDelete, ['created'])
})

test('retry creates a task if the failed request did not commit', () => {
  const current = [task({ id: 'not-committed' })]
  const recovered = recoverSaveRecords([], [], ['not-committed'])
  assert.equal(buildSaveDiff(recovered, deps, current, deps).tasksToAdd.length, 1)
})

test('retry updates a dependency whose creation committed with a lost response', () => {
  const committed: Dependency = {
    id: 'dependency', project_id: 'project-1', from_task_id: 'A', to_task_id: 'B',
    type: 2, lag: 0, active: true,
  }
  const recovered = recoverSaveRecords([], [committed], ['dependency'])
  const diff = buildSaveDiff([], recovered, [], [{ ...committed, lag: 1440 }])
  assert.equal(diff.depsToAdd.length, 0)
  assert.equal(diff.depsToUpdate[0].lag, 1440)
})

test('server-computed fields are adopted while a newer edit made during save preparation stays pending', () => {
  const submitted = [task({ id: 'A', name: 'Submitted', percent_done: 0, baseline_end_date: null })]
  const saved = [{ ...submitted[0], percent_done: 50, baseline_end_date: '2026-06-02T00:00:00' }]
  const current = [{ ...submitted[0], name: 'Edited during preparation' }]
  const merged = mergeSavedRecords(saved, submitted, current)
  assert.equal(merged[0].name, 'Edited during preparation')
  assert.equal(merged[0].percent_done, 50)
  assert.equal(merged[0].baseline_end_date, saved[0].baseline_end_date)
  assert.equal(buildSaveDiff(saved, deps, merged, deps).tasksToUpdate[0].name, current[0].name)
})
