-- Gantt App 数据库初始化脚本
-- PostgreSQL 18

-- 用户表
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username VARCHAR(50) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 项目表
CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  start_date DATE,
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
  duration INTEGER,
  duration_unit VARCHAR(20) DEFAULT 'day',
  percent_done INTEGER DEFAULT 0,
  is_milestone BOOLEAN DEFAULT false,
  auto_schedule BOOLEAN DEFAULT true,
  note TEXT,
  order_index INTEGER DEFAULT 0,
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

-- 版本表
CREATE TABLE IF NOT EXISTS versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version_number INTEGER NOT NULL,
  name VARCHAR(255) NOT NULL,
  snapshot_data JSONB NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(project_id, version_number)
);

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

-- 插入测试用户
INSERT INTO users (username, password_hash)
VALUES ('admin', '$2a$10$YourHashedPasswordHere')
ON CONFLICT (username) DO NOTHING;

-- 插入测试项目
INSERT INTO projects (user_id, name, start_date)
VALUES ((SELECT id FROM users WHERE username = 'admin' LIMIT 1), '测试项目', CURRENT_DATE)
ON CONFLICT DO NOTHING;

-- 创建示例任务
WITH admin_user AS (
  SELECT id FROM users WHERE username = 'admin' LIMIT 1
),
test_project AS (
  SELECT id FROM projects WHERE name = '测试项目' AND user_id = (SELECT id FROM admin_user) LIMIT 1
)
INSERT INTO tasks (project_id, name, start_date, end_date, duration, order_index)
SELECT
  (SELECT id FROM test_project),
  '任务1 - 基础开发',
  '2026-03-20',
  '2026-03-22',
  2,
  0
WHERE EXISTS (SELECT 1 FROM test_project)
ON CONFLICT DO NOTHING;

-- 获取刚插入的任务1 ID，并创建任务2
WITH task1 AS (
  SELECT id, project_id FROM tasks WHERE name = '任务1 - 基础开发' LIMIT 1
)
INSERT INTO tasks (project_id, name, start_date, end_date, duration, order_index)
SELECT
  project_id,
  '任务2 - 高级开发',
  '2026-03-23',
  '2026-03-25',
  2,
  1
FROM task1
WHERE EXISTS (SELECT 1 FROM task1)
ON CONFLICT DO NOTHING;

-- 创建任务1到任务2的依赖关系
WITH task1 AS (
  SELECT id FROM tasks WHERE name = '任务1 - 基础开发' LIMIT 1
),
task2 AS (
  SELECT id, project_id FROM tasks WHERE name = '任务2 - 高级开发' LIMIT 1
)
INSERT INTO dependencies (project_id, from_task_id, to_task_id, type, lag)
SELECT
  project_id,
  (SELECT id FROM task1),
  id,
  2, -- FS (Finish-to-Start)
  0
FROM task2
WHERE EXISTS (SELECT 1 FROM task1) AND EXISTS (SELECT 1 FROM task2)
ON CONFLICT (from_task_id, to_task_id) DO NOTHING;

-- 验证插入结果
SELECT 'Users:' AS info, COUNT(*) AS count FROM users
UNION ALL
SELECT 'Projects:', COUNT(*) FROM projects
UNION ALL
SELECT 'Tasks:', COUNT(*) FROM tasks WHERE is_deleted = false
UNION ALL
SELECT 'Dependencies:', COUNT(*) FROM dependencies;
