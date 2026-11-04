BEGIN;
SELECT pg_advisory_xact_lock(hashtext('gantt-project-planning-status-by-progress-v1'));
CREATE TABLE IF NOT EXISTS app_migrations (
  name TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE projects ADD COLUMN IF NOT EXISTS planning_status VARCHAR(10) NOT NULL DEFAULT 'draft';
ALTER TABLE projects ALTER COLUMN planning_status SET DEFAULT 'draft';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_planning_status_check' AND conrelid = 'projects'::regclass) THEN
    ALTER TABLE projects ADD CONSTRAINT projects_planning_status_check CHECK (planning_status IN ('draft', 'stable'));
  END IF;

  -- Initialize existing projects once, including installations of the earlier
  -- all-stable migration. Match the project list's rounded, duration-weighted
  -- leaf-task progress and status-date calculation. Later user choices survive
  -- every migration rerun; newly created projects continue to default to draft.
  IF NOT EXISTS (SELECT 1 FROM app_migrations WHERE name = 'project-planning-status-by-progress-v1') THEN
    WITH project_progress AS (
      SELECT p.id,
        CASE WHEN COALESCE(SUM(t.duration), 0) > 0 THEN
          ROUND(100.0 * COALESCE(SUM(t.duration * CASE
            WHEN p.status_date IS NULL THEN t.percent_done / 100.0
            WHEN t.end_date <= p.status_date THEN 1.0
            WHEN t.start_date >= p.status_date THEN 0
            ELSE LEAST(1.0, GREATEST(0,
              EXTRACT(EPOCH FROM (p.status_date - t.start_date))
              / NULLIF(EXTRACT(EPOCH FROM (t.end_date - t.start_date)), 0)
            ))
          END), 0) / SUM(t.duration))
        ELSE 0 END AS progress
      FROM projects p
      LEFT JOIN tasks t ON t.project_id = p.id
        AND t.is_deleted = false
        AND t.start_date IS NOT NULL AND t.end_date IS NOT NULL
        AND t.duration IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM tasks c WHERE c.parent_id = t.id AND c.is_deleted = false)
      GROUP BY p.id, p.status_date
    )
    UPDATE projects p
      SET planning_status = CASE WHEN progress.progress >= 50 THEN 'stable' ELSE 'draft' END
      FROM project_progress progress WHERE progress.id = p.id;

    INSERT INTO app_migrations (name) VALUES ('project-planning-status-by-progress-v1');
  END IF;
END $$;
COMMIT;
