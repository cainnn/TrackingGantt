-- 为 project_versions 表添加 is_autosave 标记列
ALTER TABLE project_versions ADD COLUMN IF NOT EXISTS is_autosave BOOLEAN DEFAULT false;
