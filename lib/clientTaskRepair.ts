import type { Dependency, Task } from '../types'
import { toDateTimeStr } from './clientTime'
import { planUnlinkedTaskStarts } from './unlinkedTaskSchedule'

/** A preview only: check, repair and save all use the same scheduling rules. */
export function buildTaskRepair(tasks: Task[], dependencies: Dependency[], repairDate: string, isMinute = false) {
  if (!toDateTimeStr(repairDate)) return { repairedIds: [] as string[], updates: [] as Task[] }
  const plan = planUnlinkedTaskStarts(tasks, dependencies, { anchorDate: repairDate, isMinute })
  return { repairedIds: plan.directTaskIds, updates: plan.updatedTasks }
}
