-- 版本管理"双轨制"迁移脚本
-- 工作版本: tasks/dependencies 表（可变）
-- 快照版本: project_versions 表（冻结）

-- 1. 扩展 project_versions 表
ALTER TABLE project_versions
  ADD COLUMN IF NOT EXISTS name VARCHAR(100),
  ADD COLUMN IF NOT EXISTS description TEXT;

-- 2. 为已有记录补充默认名称
UPDATE project_versions
SET name = '基线 #' || version_number
WHERE name IS NULL;

-- 3. 添加 NOT NULL 约束
ALTER TABLE project_versions
  ALTER COLUMN name SET NOT NULL,
  ALTER COLUMN name SET DEFAULT '';
