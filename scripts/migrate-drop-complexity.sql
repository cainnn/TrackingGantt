-- 移除 tasks 表中不再使用的 complexity 字段
ALTER TABLE tasks DROP COLUMN IF EXISTS complexity;
