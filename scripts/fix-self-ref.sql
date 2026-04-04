-- 修复自引用任务：parent_id 指向自身会导致渲染无限递归
-- 在 VPS 上执行：sudo -u postgres psql -d gantt_app -f /opt/gantt-app/scripts/fix-self-ref.sql

-- 1. 查看所有自引用任务
SELECT id, name, task_code, parent_id, project_id
FROM tasks
WHERE parent_id = id AND is_deleted = false;

-- 2. 将自引用的 parent_id 置空（解除自引用）
UPDATE tasks
SET parent_id = NULL, updated_at = NOW()
WHERE parent_id = id;

-- 3. 验证修复结果
SELECT count(*) AS remaining_self_refs
FROM tasks
WHERE parent_id = id;
