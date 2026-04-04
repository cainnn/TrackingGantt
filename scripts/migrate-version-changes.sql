-- 为 project_versions 表添加 changes 字段，记录每次版本与上一版本的差异
ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS changes JSONB;
