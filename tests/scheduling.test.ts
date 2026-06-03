import test from 'node:test'
import assert from 'node:assert/strict'
import { wouldCreateCycle } from '../lib/scheduling'

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
