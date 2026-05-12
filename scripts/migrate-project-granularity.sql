-- 项目时间粒度：'day'（天级，默认）或 'minute'（分钟级）
-- 创建时确定，之后不变；存量项目全部视为天级。
ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS time_granularity VARCHAR(10) DEFAULT 'day';

UPDATE projects SET time_granularity = 'day' WHERE time_granularity IS NULL;
