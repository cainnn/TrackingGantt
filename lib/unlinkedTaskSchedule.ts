import type { Task, Dependency } from '../types'
import { planScheduleCollapse } from './scheduleCollapse'

/** Read-only proposal. The caller must show it before changing the draft or saving. */
export function planUnlinkedTaskStarts(tasks: Task[], dependencies: Dependency[], options: { isMinute?: boolean; anchorDate?: string } = {}) {
  return planScheduleCollapse(tasks, dependencies, { alignUnlinked: true }, options)
}
