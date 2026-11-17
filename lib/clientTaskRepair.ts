import type { Dependency, Task } from '../types'
import { toDateTimeStr } from './clientTime'
import { planUnlinkedTaskStarts } from './unlinkedTaskSchedule'
import { planScheduleCollapse } from './scheduleCollapse'

/** A preview only: check, repair and save all use the same scheduling rules. */
export function buildTaskRepair(tasks: Task[], dependencies: Dependency[], repairDate?: string, isMinute = false) {
  if (repairDate !== undefined && !toDateTimeStr(repairDate)) return { repairedIds: [] as string[], unlinkedTaskIds: [] as string[], dependencyTaskIds: [] as string[], updates: [] as Task[], anchor: null }
  const options = { anchorDate: repairDate, isMinute }
  const plan = planUnlinkedTaskStarts(tasks, dependencies, options)
  // Historical starts are preserved only for unlinked roots. An automatic ASAP
  // successor follows its effective predecessors, even when both dates are past.
  const linked = planScheduleCollapse(plan.tasks, dependencies, { repairDependencies: true }, options)
  return { repairedIds: [...plan.directTaskIds, ...linked.directTaskIds], unlinkedTaskIds: plan.directTaskIds,
    dependencyTaskIds: linked.directTaskIds, updates: linked.tasks.filter((task, index) => task !== tasks[index]), anchor: plan.anchor }
}
