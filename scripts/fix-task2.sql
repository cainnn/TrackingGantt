-- 直接修复任务2的日期
-- 在数据库中执行此脚本

-- 更新任务2的开始日期为任务1结束日期的次日
UPDATE tasks
SET start_date = '2026-03-24',
    end_date = '2026-03-24' + (duration || ' days')::interval,
    auto_schedule = true,
    updated_at = NOW()
WHERE id = '409b5af5-976a-488d-8fd2-9ff5536e539d'
  AND project_id = 'c00b74e1-183c-4880-81b3-7c47a4885859';

-- 验证更新结果
SELECT id, name, task_code, start_date, end_date, duration, auto_schedule
FROM tasks
WHERE id = '409b5af5-976a-488d-8fd2-9ff5536e539d';
