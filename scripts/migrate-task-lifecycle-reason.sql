-- 原因随每条变更独立保存，避免同一状态日期的版本被替换后丢失。
ALTER TABLE task_lifecycle ADD COLUMN IF NOT EXISTS reason TEXT;
