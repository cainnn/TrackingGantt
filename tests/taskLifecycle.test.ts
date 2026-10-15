import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeChangeReason, resolveLifecycleReasons, type LifecycleVersion } from '../lib/taskLifecycle'
import type { TaskLifecycleEvent } from '../types'
import { describeLifecycleChange } from '../lib/taskLifecycleDisplay'

type Event = TaskLifecycleEvent & { created_by: string | null }
function event(patch: Partial<Event> = {}): Event {
  return {
    id: 'event-1', task_id: 'task-1', task_code: '55', event_type: 'updated',
    field_name: 'end_date', old_value: '2026-10-15 00:00', new_value: '2026-10-23 00:00',
    description: '结束日期调整', created_by: 'user-1', created_by_name: 'admin',
    created_at: '2026-10-15T16:32:00', ...patch,
  }
}
function version(patch: Partial<LifecycleVersion> = {}): LifecycleVersion {
  return {
    created_at: '2026-10-15T16:32:01', created_by: 'user-1', task_matches: true,
    changes: { diffs: [{ task_code: '55', task_name: '设备安装', type: 'changed',
      reason: '设备到货延期', changes: [{ field: '结束日期', old: '2026-10-15', new: '2026-10-23' }],
    }] }, ...patch,
  }
}

test('date changes display only the changed field and dates, without repeating the task name', () => {
  const change = event({ description: '任务「很长的设备安装任务名称」（55）结束日期：2026-10-15 00:00 → 2026-10-23 00:00' })
  assert.equal(describeLifecycleChange(change, false), '结束日期：2026-10-15 → 2026-10-23')
  assert.equal(describeLifecycleChange(change, true), '结束日期：2026-10-15 00:00 → 2026-10-23 00:00')
})

test('names are displayed when renamed, and other changed fields preserve their values', () => {
  assert.equal(describeLifecycleChange(event({ field_name: 'name', old_value: '旧名称', new_value: '新名称' }), false), '任务名称：旧名称 → 新名称')
  assert.equal(describeLifecycleChange(event({ field_name: 'note', old_value: null, new_value: '分批上线\n完成后下架' }), false), '备注：(空) → 分批上线\n完成后下架')
  assert.equal(describeLifecycleChange(event({ event_type: 'moved', field_name: 'parent_id', description: '任务「设备安装」（55）移至子任务，父级：「机房改造」（1）' }), false), '移至子任务，父级：「机房改造」（1）')
})

test('reasons must be non-empty text and preserve multiline explanations', () => {
  assert.equal(normalizeChangeReason('  设备到货延期\n安装顺延  '), '设备到货延期\n安装顺延')
  for (const value of [null, undefined, '', '  ', {}, 42]) assert.equal(normalizeChangeReason(value), null)
})

test('a stored reason survives snapshot replacement or deletion', () => {
  const saved = event({ reason: ' 原审批原因 ' })
  assert.equal(resolveLifecycleReasons([saved], [version()], false)[0].reason, '原审批原因')
  assert.equal(resolveLifecycleReasons([saved], [], false)[0].reason, '原审批原因')
})

test('old day-level events can recover an exact transition from a version', () => {
  assert.equal(resolveLifecycleReasons([event()], [version()], false)[0].reason, '设备到货延期')
})

test('a version cannot supply another task, user, or transition reason', () => {
  for (const candidate of [version({ task_matches: false }), version({ created_by: 'user-2' })]) {
    assert.equal(resolveLifecycleReasons([event()], [candidate], false)[0].reason, null)
  }
  for (const candidate of [event({ task_code: '56' }), event({ old_value: '2026-10-14' }), event({ field_name: 'note' })]) {
    assert.equal(resolveLifecycleReasons([candidate], [version()], false)[0].reason, null)
  }
})

test('matching does not skip an intervening version to reuse a later reason', () => {
  const earlier = version({ created_at: '2026-10-15T16:32:00.500', changes: null })
  assert.equal(resolveLifecycleReasons([event()], [version(), earlier], false)[0].reason, null)
  assert.equal(resolveLifecycleReasons([event()], [version({ created_at: '2026-10-14T00:00:00' })], false)[0].reason, null)
})

test('repeated transitions with no unique mapping remain unrecorded', () => {
  const repeated = event({ id: 'event-2', created_at: '2026-10-15T16:31:00' })
  assert.deepEqual(resolveLifecycleReasons([event(), repeated], [version()], false).map(e => e.reason), [null, null])
})

test('minute-level historical matching preserves the time of day', () => {
  const minuteVersion = version({ changes: { diffs: [{ task_code: '55', task_name: '设备安装', type: 'changed',
    reason: '施工窗口调整', changes: [{ field: '结束日期', old: '2026-10-15 10:00', new: '2026-10-15 11:00' }],
  }] } })
  const minuteEvent = event({ old_value: '2026-10-15 10:00', new_value: '2026-10-15 11:00' })
  assert.equal(resolveLifecycleReasons([minuteEvent], [minuteVersion], true)[0].reason, '施工窗口调整')
  assert.equal(resolveLifecycleReasons([{ ...minuteEvent, old_value: '2026-10-15 09:00' }], [minuteVersion], true)[0].reason, null)
})

test('legacy duration spacing is normalized without changing the unit value', () => {
  const durationVersion = version({ changes: { diffs: [{ task_code: '55', task_name: '设备安装', type: 'changed',
    reason: '增加安装工作量', changes: [{ field: '工期', old: '1天', new: '9天' }],
  }] } })
  const durationEvent = event({ field_name: 'duration', old_value: '1 天', new_value: '9 天' })
  assert.equal(resolveLifecycleReasons([durationEvent], [durationVersion], false)[0].reason, '增加安装工作量')
})
