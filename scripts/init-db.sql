-- Gantt App 数据库初始化脚本
-- PostgreSQL 18

-- uuid 生成函数 gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 用户表
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(50) UNIQUE NOT NULL,
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role VARCHAR(20) NOT NULL DEFAULT 'admin',
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 登录日志表
CREATE TABLE IF NOT EXISTS login_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ip VARCHAR(45),
  user_agent TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_login_logs_user_id ON login_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_login_logs_created_at ON login_logs(created_at);

-- 项目表
CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  start_date DATE,
  end_date DATE,
  status_date DATE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 任务表
CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
  task_code VARCHAR(50),
  name VARCHAR(255) NOT NULL,
  assignee VARCHAR(100),
  start_date DATE,
  end_date DATE,
  original_start_date DATE,
  original_end_date DATE,
  duration INTEGER,
  duration_unit VARCHAR(20) DEFAULT 'day',
  percent_done INTEGER DEFAULT 0,
  is_milestone BOOLEAN DEFAULT false,
  auto_schedule BOOLEAN DEFAULT true,
  constraint_type VARCHAR(40) DEFAULT 'asap',
  constraint_date DATE,
  deadline DATE,
  status VARCHAR(20),
  note TEXT,
  order_index INTEGER DEFAULT 0,
  rollup BOOLEAN DEFAULT false,
  inactive BOOLEAN DEFAULT false,
  project_boundary VARCHAR(20) DEFAULT 'ask',
  is_deleted BOOLEAN DEFAULT false,
  deleted_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 依赖关系表
CREATE TABLE IF NOT EXISTS dependencies (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  to_task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type INTEGER NOT NULL DEFAULT 2, -- 0=SS,1=SF,2=FS,3=FF
  lag INTEGER DEFAULT 0,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(from_task_id, to_task_id)
);

-- 任务生命周期表
CREATE TABLE IF NOT EXISTS task_lifecycle (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  task_code VARCHAR(50),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_type VARCHAR(50) NOT NULL, -- created, updated, deleted, moved
  field_name VARCHAR(100),
  old_value TEXT,
  new_value TEXT,
  description TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 版本管理表（双轨制：工作版本 + 冻结快照）
CREATE TABLE IF NOT EXISTS project_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  name VARCHAR(100) NOT NULL DEFAULT '',
  description TEXT,
  snapshot JSONB NOT NULL,
  changes JSONB,
  status_date DATE,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(project_id, version_number)
);

CREATE INDEX IF NOT EXISTS idx_project_versions_project_id ON project_versions(project_id);

-- 项目线（自定义垂直标记线）
CREATE TABLE IF NOT EXISTS project_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  line_date DATE NOT NULL,
  color VARCHAR(20) DEFAULT '#f59e0b',
  visible BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_project_lines_project_id ON project_lines(project_id);

DROP TRIGGER IF EXISTS update_project_lines_updated_at ON project_lines;
CREATE TRIGGER update_project_lines_updated_at
  BEFORE UPDATE ON project_lines
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- 兼容旧库的增量字段
ALTER TABLE tasks        ADD COLUMN IF NOT EXISTS rollup BOOLEAN DEFAULT false;
ALTER TABLE tasks        ADD COLUMN IF NOT EXISTS inactive BOOLEAN DEFAULT false;
ALTER TABLE tasks        ADD COLUMN IF NOT EXISTS project_boundary VARCHAR(20) DEFAULT 'ask';
ALTER TABLE dependencies ADD COLUMN IF NOT EXISTS active BOOLEAN DEFAULT true;
ALTER TABLE tasks        ADD COLUMN IF NOT EXISTS baseline_end_date DATE;
ALTER TABLE tasks        ADD COLUMN IF NOT EXISTS constraint_type VARCHAR(40) DEFAULT 'asap';
ALTER TABLE tasks        ADD COLUMN IF NOT EXISTS constraint_date DATE;
ALTER TABLE tasks        ADD COLUMN IF NOT EXISTS deadline DATE;
ALTER TABLE tasks        DROP COLUMN IF EXISTS complexity;

-- 历史变更审计：记录对"状态日期之前"的任务所做的回溯修改
CREATE TABLE IF NOT EXISTS task_change_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  status_date_at_change DATE,
  field VARCHAR(40) NOT NULL,
  old_value TEXT,
  new_value TEXT,
  reason TEXT,
  changed_by UUID,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_tcl_project  ON task_change_log(project_id);
CREATE INDEX IF NOT EXISTS idx_tcl_task     ON task_change_log(task_id);
CREATE INDEX IF NOT EXISTS idx_tcl_statusdt ON task_change_log(status_date_at_change);

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_parent_id ON tasks(parent_id);
CREATE INDEX IF NOT EXISTS idx_tasks_is_deleted ON tasks(is_deleted);
CREATE INDEX IF NOT EXISTS idx_dependencies_project_id ON dependencies(project_id);
CREATE INDEX IF NOT EXISTS idx_dependencies_from_task ON dependencies(from_task_id);
CREATE INDEX IF NOT EXISTS idx_dependencies_to_task ON dependencies(to_task_id);
CREATE INDEX IF NOT EXISTS idx_task_lifecycle_task_id ON task_lifecycle(task_id);
CREATE INDEX IF NOT EXISTS idx_task_lifecycle_project_id ON task_lifecycle(project_id);

-- 创建更新时间触发器函数
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 为所有需要的表添加更新时间触发器
DROP TRIGGER IF EXISTS update_users_updated_at ON users;
CREATE TRIGGER update_users_updated_at
  BEFORE UPDATE ON users
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_projects_updated_at ON projects;
CREATE TRIGGER update_projects_updated_at
  BEFORE UPDATE ON projects
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_tasks_updated_at ON tasks;
CREATE TRIGGER update_tasks_updated_at
  BEFORE UPDATE ON tasks
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

DROP TRIGGER IF EXISTS update_dependencies_updated_at ON dependencies;
CREATE TRIGGER update_dependencies_updated_at
  BEFORE UPDATE ON dependencies
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- 插入超级管理员用户（用户名: administrator  密码: admin123）
-- 可管理用户：创建、删除用户，修改密码
INSERT INTO users (username, email, password_hash, role)
VALUES ('administrator', 'administrator@example.com', '$2b$10$Zwy3LDurO3iD6N7Bowlj0uZDvAg33n7R7adAFsKzjN1FzL7RUn3pS', 'administrator')
ON CONFLICT (username) DO NOTHING;

-- 插入默认管理员用户（首次初始化）
INSERT INTO users (username, email, password_hash)
VALUES ('admin', 'admin@example.com', '$2b$10$aGgOBHIbgTHw2xtl9gGjb.63smMtPpt.TpyFrlkX/COt1sq/hB9cq')
ON CONFLICT (username) DO NOTHING;

-- 插入预置只读用户（用户名: view  密码: view123）
-- 可查看所有项目、试用AI功能，无法保存任何修改
INSERT INTO users (username, email, password_hash, role)
VALUES ('view', 'view@example.com', '$2b$10$BHI8V2g7p395KMBww8kGVOi9eQ7WDWg8i9bB9s42xz.7lIRPgQmG6', 'view')
ON CONFLICT (username) DO NOTHING;
