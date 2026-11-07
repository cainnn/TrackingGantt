import test from 'node:test'
import assert from 'node:assert/strict'
import { planSubmittedHierarchy, isSubmittedTaskBatch } from '../lib/submittedTaskHierarchy'

test('submitted final hierarchy permits parent-child reversal regardless of payload order', () => {
  const plan = planSubmittedHierarchy([{ id: 'A', parent_id: null }, { id: 'B', parent_id: 'A' }],
    [{ id: 'A', parent_id: 'B' }, { id: 'B', parent_id: null }])
  assert.deepEqual(plan.repairs, [])
  assert.deepEqual(plan.parents, [{ id: 'A', parent_id: 'B' }, { id: 'B', parent_id: null }])
})
test('resubmitted tasks restore needed deleted ancestors without restoring deleted siblings', () => {
  const plan = planSubmittedHierarchy([
    { id: 'A', parent_id: null, is_deleted: true }, { id: 'B', parent_id: 'A', is_deleted: true },
    { id: 'C', parent_id: 'A', is_deleted: true },
  ], [{ id: 'B', name: 'User changes' }])
  assert.deepEqual(plan.restoreIds.sort(), ['A', 'B'])
  assert.equal(plan.repairs.length, 0)
})
test('invalid parent references preserve an existing valid parent and retain every submitted task', () => {
  for (const parent of ['missing', 'self', 'another-project']) {
    const plan = planSubmittedHierarchy([{ id: 'P' }, { id: 'self', parent_id: 'P' }],
      [{ id: 'self', parent_id: parent, name: 'Keep this edit' }, { id: 'new', parent_id: null }])
    assert.equal(plan.parents.find(p => p.id === 'self')?.parent_id, 'P')
    assert.equal(plan.parents.find(p => p.id === 'new')?.parent_id, null)
    assert.equal(plan.repairs.length, 1)
    assert.equal(plan.repairs[0].requestedParent, parent)
  }
})
test('cycles in a submitted batch are broken without discarding task content', () => {
  const plan = planSubmittedHierarchy([], [{ id: 'A', parent_id: 'B' }, { id: 'B', parent_id: 'C' }, { id: 'C', parent_id: 'A' }])
  assert.equal(plan.parents.length, 3)
  assert.equal(plan.repairs.length, 1)
  assert.equal(plan.parents.find(p => p.id === 'A')?.parent_id, null)
})
test('an orphan task remains a root and unrelated deleted or malformed records stay untouched', () => {
  const plan = planSubmittedHierarchy([{ id: 'unused', is_deleted: true, parent_id: 'foreign' }],
    [{ id: 'new', parent_id: 'missing', name: 'Preserved' }])
  assert.deepEqual(plan.parents, [{ id: 'new', parent_id: null }])
  assert.deepEqual(plan.restoreIds, [])
})

test('breaking a cycle still restores a valid previous ancestor when needed', () => {
  const plan = planSubmittedHierarchy([{ id: 'P', is_deleted: true }, { id: 'A', parent_id: 'P' }],
    [{ id: 'A', parent_id: 'B' }, { id: 'B', parent_id: 'A' }])
  assert.equal(plan.parents.find(t => t.id === 'A')?.parent_id, 'P')
  assert.deepEqual(plan.restoreIds, ['P'])
})

test('legacy full-row arrays are confirmed submissions while partial API updates keep strict validation', () => {
  const full = { id: 'A', name: 'A', parent_id: null, start_date: null, end_date: null, duration: null, order_index: 0 }
  assert.equal(isSubmittedTaskBatch([full]), true)
  assert.equal(isSubmittedTaskBatch(full), false)
  assert.equal(isSubmittedTaskBatch([{ id: 'A', parent_id: 'foreign' }]), false)
})

test('empty parent inputs mean a root task and do not cause a UUID write failure', () => {
  const plan = planSubmittedHierarchy([{ id: 'P' }, { id: 'A', parent_id: 'P' }], [{ id: 'A', parent_id: '  ' }])
  assert.deepEqual(plan.parents, [{ id: 'A', parent_id: null }])
  assert.deepEqual(plan.repairs, [])
})
