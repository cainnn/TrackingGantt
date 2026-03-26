export interface User {
  id: string
  username: string
  email: string
  created_at: string
}

export interface Project {
  id: string
  user_id: string
  name: string
  start_date: string | null
  end_date: string | null
  status_date: string | null
  created_at: string
  progress?: number  // 项目完成进度百分比 (0-100)
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

export interface ChangeLog {
  id: string
  change_type: string
  task_name: string | null
  field_name: string | null
  old_value: string | null
  new_value: string | null
  description: string
}

export interface ProjectVersion {
  id: string
  project_id: string
  version_number: number
  task_count: number
  created_by_name: string | null
  created_at: string
  changes: ChangeLog[]
}
