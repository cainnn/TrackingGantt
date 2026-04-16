-- 为 tasks 表添加 deadline 字段，用于任务截止日期提示
ALTER TABLE tasks ADD COLUMN IF NOT EXISTS deadline DATE;
