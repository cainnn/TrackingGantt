BEGIN;
SELECT pg_advisory_xact_lock(hashtext('gantt-project-start-from-tasks-v1'));

-- Older installations may still store project starts as DATE, losing minute precision.
DO $$ BEGIN
  IF (SELECT data_type FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = 'projects' AND column_name = 'start_date') = 'date' THEN
    ALTER TABLE projects ALTER COLUMN start_date TYPE TIMESTAMP USING start_date::timestamp;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_tasks_live_project_start
  ON tasks (project_id, start_date) WHERE is_deleted = false AND start_date IS NOT NULL;

CREATE OR REPLACE FUNCTION derive_project_start() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.start_date := (SELECT MIN(t.start_date) FROM tasks t WHERE t.project_id = NEW.id AND t.is_deleted = false);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS projects_derive_start ON projects;
CREATE TRIGGER projects_derive_start BEFORE INSERT OR UPDATE OF start_date ON projects
  FOR EACH ROW EXECUTE FUNCTION derive_project_start();

-- Statement transition tables recalculate each affected project once per SQL batch.
CREATE OR REPLACE FUNCTION sync_task_project_starts() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE project_ids UUID[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT array_agg(DISTINCT project_id) INTO project_ids FROM changed_new;
  ELSIF TG_OP = 'DELETE' THEN
    SELECT array_agg(DISTINCT project_id) INTO project_ids FROM changed_old;
  ELSE
    SELECT array_agg(DISTINCT project_id) INTO project_ids FROM (
      SELECT n.project_id FROM changed_new n JOIN changed_old o USING (id)
      WHERE (n.start_date, n.is_deleted, n.project_id) IS DISTINCT FROM (o.start_date, o.is_deleted, o.project_id)
      UNION
      SELECT o.project_id FROM changed_new n JOIN changed_old o USING (id)
      WHERE (n.start_date, n.is_deleted, n.project_id) IS DISTINCT FROM (o.start_date, o.is_deleted, o.project_id)
    ) affected;
  END IF;
  IF project_ids IS NULL THEN RETURN NULL; END IF;
  -- Serialize before reading MIN; NO KEY UPDATE remains compatible with FK checks.
  PERFORM id FROM projects WHERE id = ANY(project_ids) ORDER BY id FOR NO KEY UPDATE;
  UPDATE projects p SET start_date = (
    SELECT MIN(t.start_date) FROM tasks t WHERE t.project_id = p.id AND t.is_deleted = false
  ) WHERE p.id = ANY(project_ids) AND p.start_date IS DISTINCT FROM (
    SELECT MIN(t.start_date) FROM tasks t WHERE t.project_id = p.id AND t.is_deleted = false
  );
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS tasks_sync_project_start_insert ON tasks;
DROP TRIGGER IF EXISTS tasks_sync_project_start_update ON tasks;
DROP TRIGGER IF EXISTS tasks_sync_project_start_delete ON tasks;
CREATE TRIGGER tasks_sync_project_start_insert AFTER INSERT ON tasks
  REFERENCING NEW TABLE AS changed_new FOR EACH STATEMENT EXECUTE FUNCTION sync_task_project_starts();
CREATE TRIGGER tasks_sync_project_start_update AFTER UPDATE ON tasks
  REFERENCING OLD TABLE AS changed_old NEW TABLE AS changed_new FOR EACH STATEMENT EXECUTE FUNCTION sync_task_project_starts();
CREATE TRIGGER tasks_sync_project_start_delete AFTER DELETE ON tasks
  REFERENCING OLD TABLE AS changed_old FOR EACH STATEMENT EXECUTE FUNCTION sync_task_project_starts();

-- Backfill metadata only. Task dates and historical snapshots are never rewritten.
UPDATE projects p SET start_date = (SELECT MIN(t.start_date) FROM tasks t WHERE t.project_id = p.id AND t.is_deleted = false)
WHERE p.start_date IS DISTINCT FROM (SELECT MIN(t.start_date) FROM tasks t WHERE t.project_id = p.id AND t.is_deleted = false);
COMMIT;
