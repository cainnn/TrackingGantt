-- 用户角色字段迁移 + 版本表 status_date 迁移

-- 1. 为 users 表添加 role 字段
ALTER TABLE users ADD COLUMN IF NOT EXISTS role VARCHAR(20) NOT NULL DEFAULT 'admin';

-- 2. 为 project_versions 表添加 status_date 字段
ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS status_date DATE;

-- 3. is_baseline 已废弃，保留列不影响功能（避免破坏性 DDL）
