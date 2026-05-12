-- 分钟级时间轴迁移
-- 把所有 DATE 字段升级为 TIMESTAMP；
-- 现有任务 start_date → 当天 09:00，end_date → 当天 18:00；
-- 其它日期字段保留为当天 00:00（不带时间含义的字段）；
-- tasks.duration 重新计算为分钟数，duration_unit 默认改为 'minute'；
-- dependencies.lag 由"天"改为"分钟"（按一个工作日 9 小时 = 540 分钟换算）。
--
-- 幂等：通过检查 tasks.start_date 列类型决定是否执行。

DO $$
DECLARE
  is_first_run BOOLEAN;
BEGIN
  is_first_run := (
    SELECT data_type FROM information_schema.columns
    WHERE table_name='tasks' AND column_name='start_date'
  ) = 'date';

  IF NOT is_first_run THEN
    RAISE NOTICE 'minute-timeline migration already applied, skipping';
    RETURN;
  END IF;

  -- projects
  ALTER TABLE projects
    ALTER COLUMN start_date  TYPE TIMESTAMP USING (start_date  + INTERVAL '9 hours'),
    ALTER COLUMN end_date    TYPE TIMESTAMP USING (end_date    + INTERVAL '18 hours'),
    ALTER COLUMN status_date TYPE TIMESTAMP USING (status_date::TIMESTAMP);

  -- tasks 核心日期字段
  ALTER TABLE tasks
    ALTER COLUMN start_date          TYPE TIMESTAMP USING (start_date          + INTERVAL '9 hours'),
    ALTER COLUMN end_date            TYPE TIMESTAMP USING (end_date            + INTERVAL '18 hours'),
    ALTER COLUMN original_start_date TYPE TIMESTAMP USING (original_start_date + INTERVAL '9 hours'),
    ALTER COLUMN original_end_date   TYPE TIMESTAMP USING (original_end_date   + INTERVAL '18 hours'),
    ALTER COLUMN constraint_date     TYPE TIMESTAMP USING (constraint_date::TIMESTAMP),
    ALTER COLUMN deadline            TYPE TIMESTAMP USING (deadline            + INTERVAL '18 hours'),
    ALTER COLUMN baseline_end_date   TYPE TIMESTAMP USING (baseline_end_date   + INTERVAL '18 hours');

  -- duration 重新计算为分钟数（已有数据按新的 09:00–18:00 时间窗推导）
  UPDATE tasks
  SET duration      = (EXTRACT(EPOCH FROM (end_date - start_date)) / 60)::INTEGER,
      duration_unit = 'minute'
  WHERE start_date IS NOT NULL AND end_date IS NOT NULL;

  -- 默认值改为 minute
  ALTER TABLE tasks ALTER COLUMN duration_unit SET DEFAULT 'minute';

  -- dependencies.lag：天数 → 分钟数（按 9 小时工作日）
  UPDATE dependencies SET lag = lag * 540 WHERE lag IS NOT NULL AND lag <> 0;

  -- 其它 DATE 字段（保持当天 00:00）
  ALTER TABLE project_versions ALTER COLUMN status_date           TYPE TIMESTAMP USING (status_date::TIMESTAMP);
  ALTER TABLE project_lines    ALTER COLUMN line_date             TYPE TIMESTAMP USING (line_date::TIMESTAMP);
  ALTER TABLE task_change_log  ALTER COLUMN status_date_at_change TYPE TIMESTAMP USING (status_date_at_change::TIMESTAMP);

  RAISE NOTICE 'minute-timeline migration applied successfully';
END$$;
