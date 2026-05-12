export interface User {
  id: string
  username: string
  email: string
  role: 'administrator' | 'admin' | 'view'
  created_at: string
}

export type TimeGranularity = 'day' | 'minute'

export interface Project {
  id: string
  user_id: string
  name: string
  start_date: string | null
  end_date: string | null
  status_date: string | null
  time_granularity?: TimeGranularity  // 'day' 或 'minute'，创建时固定
  created_at: string
  progress?: number
  estimated_end_date?: string | null
}

export interface Task {
  id: string
  project_id: string
  parent_id: string | null
  task_code: string
  name: string
  assignee: string | null
  start_date: string | null
  end_date: string | null
  duration: number | null
  duration_unit: string
  percent_done: number
  is_milestone: boolean
  note: string | null
  order_index: number
  is_deleted: boolean
  deleted_at: string | null
  auto_schedule?: boolean  // 默认 true：根据前置依赖自动调整开始时间
  constraint_type?: string | null  // 限制类型: asap | alap | startnoearlierthan | finishnolaterthan | null
  constraint_date?: string | null
  deadline?: string | null    // 截止日期：计划结束日期超过此日期时需要提示
  status?: string | null      // 状态: notstarted | started | completed | late
  rollup?: boolean
  inactive?: boolean
  project_boundary?: string | null  // ask | honor | ignore
  baseline_end_date?: string | null // 上次"确认变更"时的 end_date 快照；用于延期判定
  original_start_date?: string | null  // 任务首次成为摘要任务前的原始日期，恢复用
  original_end_date?: string | null
  created_at: string
  updated_at: string
}

export interface TaskLifecycleEvent {
  id: string
  task_id: string
  task_code: string
  event_type: string
  field_name: string | null
  old_value: string | null
  new_value: string | null
  description: string
  created_by_name: string | null
  created_at: string
}

export interface Dependency {
  id: string
  project_id: string
  from_task_id: string
  to_task_id: string
  type: number
  lag: number
  active?: boolean
}

export interface CreateTaskInput {
  name: string
  parent_id?: string | null
  start_date?: string | null
  end_date?: string | null
  duration?: number | null
  duration_unit?: string
  percent_done?: number
  is_milestone?: boolean
  note?: string | null
  order_index?: number
}

export interface UpdateTaskInput extends Partial<CreateTaskInput> {
  id: string
}

export interface VersionDiffItem {
  task_code: string
  task_name: string
  type: 'added' | 'removed' | 'changed'
  changes?: { field: string; old: string; new: string }[]
}

export interface VersionChanges {
  diffs: VersionDiffItem[]
  stats: { added: number; removed: number; changed: number }
}

export interface ProjectVersion {
  id: string
  project_id: string
  version_number: number
  name: string
  description: string | null
  status_date: string | null
  created_by: string | null
  created_at: string
  task_count?: number
  changes?: VersionChanges | null
  is_autosave?: boolean
}

export interface ProjectLine {
  id: string
  project_id: string
  name: string
  line_date: string
  color: string
  visible: boolean
}

