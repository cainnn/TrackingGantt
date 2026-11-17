import type { Task, Dependency } from '../types'
import { planScheduleCollapse } from './scheduleCollapse'

/** Remove links and tighten only the affected automatic schedule, in one draft step. */
export function planDependencyRemoval(
  tasks: Task[], dependencies: Dependency[], ids: Iterable<string>,
  options: { isMinute?: boolean; removalDate?: string } = {},
) {
  const requested = new Set(ids)
  const removedDependencies = dependencies.filter(d => requested.has(d.id))
  const remaining = dependencies.filter(d => !requested.has(d.id))
  const plan = planScheduleCollapse(tasks, remaining, { removedDependencies }, { isMinute: options.isMinute, anchorDate: options.removalDate })
  return { tasks: plan.tasks, updatedTasks: plan.updatedTasks, dependencies: remaining, removedDependencies }
}
