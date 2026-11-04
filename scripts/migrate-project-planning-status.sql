BEGIN;
-- Existing projects remain stable. Only subsequently created projects default
-- to draft; rerunning this migration never resets a project's chosen state.
ALTER TABLE projects ADD COLUMN IF NOT EXISTS planning_status VARCHAR(10) NOT NULL DEFAULT 'stable';
ALTER TABLE projects ALTER COLUMN planning_status SET DEFAULT 'draft';
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'projects_planning_status_check' AND conrelid = 'projects'::regclass) THEN
    ALTER TABLE projects ADD CONSTRAINT projects_planning_status_check CHECK (planning_status IN ('draft', 'stable'));
  END IF;
END $$;
COMMIT;
